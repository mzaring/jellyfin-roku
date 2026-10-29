'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { loadLogo, sniffType, isSvg, samplePng, defaultRasterizer, LogoError } = require('./logo');

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

// A stand-in for fetch()
const reply = (bytes, { ok = true, status = 200 } = {}) => async () => ({
  ok,
  status,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

test('recognizes image types from the bytes themselves', () => {
  assert.equal(sniffType(samplePng([1, 2, 3])), 'image/png');
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffType(Buffer.from('<html>nope</html>')), null);
});

test('recognizes SVG with or without an XML header, BOM or leading whitespace', () => {
  assert.equal(isSvg(SVG), true);
  assert.equal(isSvg(Buffer.from('<?xml version="1.0"?>\n<svg></svg>')), true);
  assert.equal(isSvg(Buffer.from('﻿  \n<svg></svg>')), true);
  assert.equal(isSvg(samplePng([1, 2, 3])), false);
  assert.equal(isSvg(Buffer.from('<html><body>not an svg</body></html>')), false);
});

test('the generated sample logo is a valid PNG of the right size', () => {
  const png = samplePng([10, 20, 30], 64);
  assert.equal(png.readUInt32BE(16), 64, 'width');
  assert.equal(png.readUInt32BE(20), 64, 'height');
  // IHDR is 25 bytes after the 8-byte signature; the IDAT data decompresses to rows of 1 + 4*64 bytes
  const idatAt = png.indexOf('IDAT');
  const idatLength = png.readUInt32BE(idatAt - 4);
  const pixels = zlib.inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLength));
  assert.equal(pixels.length, 64 * (1 + 64 * 4));
});

test('PNG, JPEG and GIF logos pass straight through', async () => {
  const png = samplePng([9, 9, 9]);
  const out = await loadLogo('https://x.test/logo', { fetcher: reply(png) });
  assert.equal(out.type, 'image/png');
  assert.equal(out.converted, false);
  assert.ok(out.bytes.equals(png));

  assert.equal((await loadLogo('https://x.test/a', { fetcher: reply(JPEG) })).type, 'image/jpeg');
});

test('SVG logos are converted to PNG by the rasterizer', async () => {
  const seen = [];
  const rasterize = (bytes) => {
    seen.push(bytes.toString());
    return samplePng([1, 1, 1]);
  };
  const out = await loadLogo('https://x.test/bear.svg', { fetcher: reply(SVG), rasterize });
  assert.equal(out.type, 'image/png');
  assert.equal(out.converted, true);
  assert.match(seen[0], /<svg/);
});

test('a rasterizer that returns junk is reported, not served', async () => {
  await assert.rejects(
    loadLogo('https://x.test/bear.svg', { fetcher: reply(SVG), rasterize: () => Buffer.from('junk') }),
    /Could not convert/,
  );
});

test('WebP is rejected with a clear reason, since Roku cannot draw it', async () => {
  const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 ');
  await assert.rejects(loadLogo('https://x.test/a.webp', { fetcher: reply(webp) }), /WebP/);
});

test('HTML error pages and other non-images are rejected', async () => {
  await assert.rejects(
    loadLogo('https://x.test/a', { fetcher: reply(Buffer.from('<html>Access denied</html>')) }),
    (err) => err instanceof LogoError && /not an image/.test(err.message),
  );
});

test('HTTP errors, network failures and odd sizes are reported', async () => {
  await assert.rejects(loadLogo('https://x.test/a', { fetcher: reply(Buffer.alloc(0), { ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(
    loadLogo('https://x.test/a', {
      fetcher: async () => {
        throw new Error('ECONNRESET');
      },
    }),
    /Could not download/,
  );
  await assert.rejects(loadLogo('https://x.test/a', { fetcher: reply(Buffer.alloc(0)) }), /unexpected size/);
  await assert.rejects(loadLogo('https://x.test/a', { fetcher: reply(Buffer.alloc(3 * 1024 * 1024, 1)) }), /unexpected size/);
});

// Only meaningful when the optional converter has not been installed
let converterInstalled = true;
try {
  require.resolve('@resvg/resvg-js');
} catch (err) {
  converterInstalled = false;
}

test('without the optional converter, SVG logos explain how to enable it', { skip: converterInstalled }, () => {
  assert.throws(() => defaultRasterizer(SVG), /npm install/);
});

test('with the optional converter, a real SVG becomes a real PNG', { skip: !converterInstalled }, () => {
  const png = defaultRasterizer(SVG);
  assert.equal(sniffType(png), 'image/png');
  assert.equal(png.readUInt32BE(16), 128, 'rendered at the configured width');
});
