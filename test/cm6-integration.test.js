const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('CodeMirror 6 standalone bundle integration test', async (t) => {
  // 1. Load and evaluate CodeMirror 6 bundle in isolated VM environment
  const bundleCode = fs.readFileSync('Firefox/lib/codemirror.bundle.js', 'utf8');
  assert.ok(bundleCode.length > 100000, 'Bundle must have valid content');

  const mockDoc = {
    createElement: () => ({ style: {}, setAttribute: () => { }, appendChild: () => { } }),
    createTextNode: () => ({}),
    documentElement: { style: {} },
    head: { appendChild: () => { } },
    body: { style: {} },
    addEventListener: () => { }
  };

  const context = {
    window: {},
    console: console,
    document: mockDoc,
    navigator: { userAgent: 'Node' }
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(bundleCode, context);

  const CM6 = context.CodeMirror6 || context.window.CodeMirror6;
  assert.ok(CM6, 'CodeMirror6 global must be exported');

  const {
    EditorState,
    markdown,
    syntaxTree,
    history,
    searchKeymap,
    snippet
  } = CM6;

  // 2. Fail-fast verification: required symbols must exist
  assert.ok(EditorState, 'EditorState must exist');
  assert.ok(markdown, 'markdown language plugin must exist');
  assert.ok(syntaxTree, 'syntaxTree utility must exist');
  assert.ok(snippet, 'snippet utility must exist');
  assert.ok(Array.isArray(searchKeymap), 'searchKeymap must be an array');

  // 3. Initialize state and verify Markdown AST parsing
  const initialDoc = '# Heading 1\n\n- [ ] Task 1\n\n```js\nconst x = 1;\n```';
  const state = EditorState.create({
    doc: initialDoc,
    extensions: [markdown(), history()]
  });

  assert.equal(state.doc.toString(), initialDoc, 'Document text matches input');

  // 4. Test AST Heading detection
  let headingCount = 0;
  const tree = syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name.startsWith('ATXHeading')) {
        headingCount++;
      }
    }
  });
  assert.equal(headingCount, 1, 'AST correctly identifies heading');

  // 5. Test Transaction Dispatch & Text replacement
  const tr = state.update({
    changes: { from: 0, to: 11, insert: '# New Title' }
  });
  const newState = tr.state;
  assert.ok(newState.doc.toString().startsWith('# New Title'), 'Transaction correctly updates doc');

  // 5b. Source <-> rendered offset map (mirrors Editor.mapBlock in app.js).
  // This is what editor/preview selection sync relies on: markup characters (**, *, `, #, >,
  // and link targets) carry no rendered text, so mapping by raw string search fails on any
  // selection containing them.
  const MARKUP_NODE_RE = /Mark$|^URL$|^LinkTitle$|^CodeInfo$/;

  function mapBlock(docText, from, to) {
    const st = EditorState.create({ doc: docText, extensions: [markdown()] });
    const skips = [];
    syntaxTree(st).iterate({
      from,
      to,
      enter: (node) => {
        if (MARKUP_NODE_RE.test(node.name)) skips.push([node.from, node.to]);
      }
    });
    skips.sort((a, b) => a[0] - b[0]);

    let rendered = '';
    const srcToRen = new Map();
    const renToSrc = new Map();
    let pos = from;
    const emit = (until) => {
      for (let i = pos; i < until; i++) {
        srcToRen.set(i, rendered.length);
        renToSrc.set(rendered.length, i);
        rendered += docText[i];
      }
    };
    for (const [s, e] of skips) {
      if (s > pos) emit(s);
      pos = Math.max(pos, e);
    }
    emit(to);
    return { rendered, srcToRen, renToSrc };
  }

  const mapCases = [
    ['Hello **bold** and *it* and [link](http://x) and `code` here.', 'Hello bold and it and link and code here.'],
    ['## A heading here', 'A heading here'],
    ['> quoted **text**', 'quoted text'],
    ['plain sentence', 'plain sentence']
  ];

  for (const [src, expected] of mapCases) {
    const { rendered } = mapBlock(src, 0, src.length);
    assert.equal(rendered.trim(), expected, `markup stripped correctly for: ${src}`);
  }

  // Round-trip a selection in both directions through the map
  const richSrc = mapCases[0][0];
  const richMap = mapBlock(richSrc, 0, richSrc.length);

  const boldSrc = richSrc.indexOf('bold');
  const boldRenStart = richMap.srcToRen.get(boldSrc);
  const boldRenEnd = richMap.srcToRen.get(boldSrc + 3) + 1;
  assert.equal(
    richMap.rendered.slice(boldRenStart, boldRenEnd),
    'bold',
    'source->rendered maps a selection inside ** ** correctly'
  );

  const linkRen = richMap.rendered.indexOf('link');
  const linkSrcStart = richMap.renToSrc.get(linkRen);
  const linkSrcEnd = richMap.renToSrc.get(linkRen + 3) + 1;
  assert.equal(
    richSrc.slice(linkSrcStart, linkSrcEnd),
    'link',
    'rendered->source maps a selection inside a link label back to the source text'
  );

  // 6. Test 7z WASM archive creation with relative assets
  const path = require('node:path');
  const SevenZip = require(path.resolve(__dirname, '../Firefox/lib/7zz.umd.js'));
  const sz = await SevenZip({
    locateFile: (p) => path.resolve(__dirname, '../Firefox/lib', p)
  });
  sz.FS.writeFile('document.md', '# Document\n\n![diagram](assets/chart.png)');
  try { sz.FS.mkdir('assets'); } catch (_) { }
  sz.FS.writeFile('assets/chart.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  sz.callMain(['a', 'document.7z', 'document.md', 'assets']);
  const archiveBytes = sz.FS.readFile('document.7z');
  assert.ok(archiveBytes.length > 0, '7z archive generated');
  assert.equal(archiveBytes[0], 0x37, '7z magic byte 1');
  assert.equal(archiveBytes[1], 0x7a, '7z magic byte 2');
  assert.equal(archiveBytes[2], 0xbc, '7z magic byte 3');
  assert.equal(archiveBytes[3], 0xaf, '7z magic byte 4');
});
