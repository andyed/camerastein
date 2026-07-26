import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlUrl = new URL('../index.html', import.meta.url);
const cssUrl = new URL('../css/app.css', import.meta.url);

test('every app mode inherits one canonical Camerastein GitHub link', async () => {
    const html = await readFile(htmlUrl, 'utf8');
    const matches = html.match(/id="github-project-link"/g) || [];

    assert.equal(matches.length, 1);
    assert.match(html, /href="https:\/\/github\.com\/andyed\/camerastein"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /aria-label="View the Camerastein project on GitHub \(opens in a new tab\)"/);
});

test('the project link is structural, touch-sized, and retained on narrow screens', async () => {
    const css = await readFile(cssUrl, 'utf8');

    assert.match(css, /#project-footer\s*\{[^}]*flex-shrink:\s*0;/s);
    assert.match(css, /#github-project-link\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
    assert.match(css, /@media \(max-width: 680px\)[\s\S]*#github-project-link\s*\{[^}]*width:\s*100%;/);
});
