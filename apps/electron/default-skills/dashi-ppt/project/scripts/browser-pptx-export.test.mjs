import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const templateUrl = new URL('../assets/template-swiss.html', import.meta.url);

test('editable PPTX export runs inside the sandboxed preview document', async () => {
  const template = await readFile(templateUrl, 'utf8');

  assert.doesNotMatch(template, /frame\.src = location\.pathname \+ location\.search/);
  assert.doesNotMatch(template, /frame\.contentDocument/);
  assert.doesNotMatch(template, /if\(isCodexInAppBrowser\(\)\)/);
  assert.match(template, /const win = window;/);
  assert.match(template, /const doc = document;/);
});

test('editable PPTX visual capture cannot hang on sandboxed font loading', async () => {
  const template = await readFile(templateUrl, 'utf8');

  assert.match(template, /skipFonts: true/);
  assert.match(template, /页面视觉采集超时/);
  assert.match(template, /htmlToImage: sandboxSafeHtmlToImage/);
});
