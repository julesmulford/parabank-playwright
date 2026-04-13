/**
 * Test Generator Agent
 *
 * Given a feature description, generates a complete Playwright test following
 * the project's conventions: fixtures import, describe block, page objects,
 * correct locator priority, no hardcoded data.
 *
 * Usage:
 *   npx tsx tests/agents/testGenerator.ts --feature "transfer funds between accounts"
 *   npx tsx tests/agents/testGenerator.ts --feature "loan request" --type api
 *   npx tsx tests/agents/testGenerator.ts --feature "login page" --write
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic();

// ── context loaders ────────────────────────────────────────────────────────

function loadExistingContext(): string {
  const files: Record<string, string> = {
    'tests/fixtures/fixtures.ts': '',
    'tests/data/types.ts': '',
    'tests/data/factories.ts': '',
    'tests/pages/RegistrationPage.ts': '',
    'tests/pages/LoginPage.ts': '',
    'tests/ui/registration.spec.ts': '',
  };

  const sections: string[] = [];
  for (const [filePath, _] of Object.entries(files)) {
    if (fs.existsSync(filePath)) {
      sections.push(`### ${filePath}\n\`\`\`typescript\n${fs.readFileSync(filePath, 'utf-8')}\n\`\`\``);
    }
  }
  return sections.join('\n\n');
}

function deriveOutputPath(feature: string, testType: string): string {
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const dir = testType === 'api' ? 'tests/api' : 'tests/ui';
  return path.join(dir, `${slug}.spec.ts`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function generateTest(feature: string, testType: string, write: boolean) {
  const context = loadExistingContext();
  const outputPath = deriveOutputPath(feature, testType);

  const prompt = `You are a Playwright test automation engineer. Generate a complete, production-ready test for the following feature.

## Feature
"${feature}"

## Test type
${testType === 'api' ? 'API test (use the request fixture, no browser)' : 'UI test (use page objects via fixtures)'}

## Project conventions (MUST follow exactly)

### Imports
- ALWAYS import { test, expect } from '../fixtures/fixtures' — never from @playwright/test directly
- API tests may import { request } from @playwright/test for raw context setup

### File placement
- UI tests → tests/ui/
- API tests → tests/api/

### Page objects
- One class per page, constructor declares all locators as readonly
- No assertions inside page objects — actions only
- Export the class and a data interface alongside it
- Add the page object to tests/fixtures/fixtures.ts

### Locator priority (best → last resort)
1. getByRole('button', { name: '...' })
2. getByLabel('...')
3. getByTestId('...')
4. getByText('...') / getByPlaceholder('...')
5. locator('[id="..."]')
Never use XPath, CSS class selectors, or positional selectors.

### Test data
- Use factory functions from tests/data/factories.ts
- Never hardcode usernames or data that collides in parallel runs

### Test structure
- Wrap tests in test.describe blocks
- Tag smoke tests: test('login @smoke', ...)
- No page.waitForTimeout() — use expect(locator).toBeVisible()

## Existing code (for reference — match these patterns)
${context}

## Output
Produce:
1. Any new page object file(s) needed (if UI test)
2. The spec file

For each file, show the path as a comment on the first line, then the TypeScript code in a \`\`\`typescript block.
`;

  console.log(`Generating ${testType} test for: "${feature}"\n`);

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  let fullText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }

  console.log('\n');

  if (write) {
    // Extract all ```typescript blocks with their path comments
    const blocks = [...fullText.matchAll(/\/\/ (.+\.ts)\n```typescript\n([\s\S]*?)```/g)];
    if (blocks.length === 0) {
      // Fallback: write the first typescript block to the derived path
      const match = fullText.match(/```typescript\n([\s\S]*?)```/);
      if (match) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, match[1]);
        console.log(`Written: ${outputPath}`);
      }
    } else {
      for (const [, filePath, content] of blocks) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        console.log(`Written: ${filePath}`);
      }
    }
    console.log('\nRemember to add any new page objects to tests/fixtures/fixtures.ts');
  }
}

// ── entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const featureFlag = args.indexOf('--feature');
const typeFlag = args.indexOf('--type');
const feature = featureFlag !== -1 ? args[featureFlag + 1] : null;
const testType = typeFlag !== -1 ? args[typeFlag + 1] : 'ui';
const write = args.includes('--write');

if (!feature) {
  console.error(
    'Usage: npx tsx tests/agents/testGenerator.ts --feature "description" [--type ui|api] [--write]',
  );
  process.exit(1);
}

generateTest(feature, testType, write);
