'use strict';

// Team logos for the Roku overlay.
//
// The Roku can only draw PNG, JPEG and GIF, and it is happiest loading images from your own network.
// So the proxy downloads each logo from ESPN itself and serves it back at /logo/<teamId>.png:
//   - PNG / JPEG / GIF pass straight through.
//   - SVG (which ESPN's built-in logo packs may use) is converted to PNG, if the optional
//     @resvg/resvg-js package is installed (`npm install` in this folder does that).
//   - Anything else is reported in the proxy's log, and the overlay just shows no logo.

const zlib = require('node:zlib');
const { UserError } = require('./espn');

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const RENDER_WIDTH = 128; // shown at 64px on the TV; 2x keeps it crisp

class LogoError extends UserError {
  constructor(message, status = 502) {
    super(message, status);
    this.name = 'LogoError';
  }
}

// What kind of image are these bytes? Looks at the bytes, not at what the server claims.
function sniffType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function isSvg(bytes) {
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || /^<!doctype svg/i.test(head);
}

function defaultRasterizer(svgBytes) {
  let Resvg;
  try {
    ({ Resvg } = require('@resvg/resvg-js'));
  } catch (err) {
    throw new LogoError('Logo is an SVG: run "npm install" in fantasy-proxy so it can be converted');
  }
  const resvg = new Resvg(svgBytes, {
    fitTo: { mode: 'width', value: RENDER_WIDTH },
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

// Downloads one logo and returns { type, bytes } ready to serve.
// fetcher and rasterize can be swapped out (the tests do).
async function loadLogo(url, { fetcher = fetch, rasterize = defaultRasterizer } = {}) {
  let res;
  try {
    res = await fetcher(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; jellyfin-roku-fantasy-proxy)' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new LogoError('Could not download the team logo');
  }
  if (!res.ok) throw new LogoError(`Team logo request returned HTTP ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw new LogoError('Team logo has an unexpected size');

  if (isSvg(bytes)) {
    const png = rasterize(bytes);
    if (sniffType(png) !== 'image/png') throw new LogoError('Could not convert the SVG logo');
    return { type: 'image/png', bytes: png, converted: true };
  }

  const type = sniffType(bytes);
  if (type === 'image/webp') throw new LogoError('Team logo is a WebP image, which the Roku cannot display');
  if (!type) throw new LogoError('Team logo is not an image the Roku can display');
  return { type, bytes, converted: false };
}

// A plain round PNG, so the logo path can be tried (and tested) without ESPN.
function samplePng(rgb, size = 96) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = Math.max(0, Math.min(1, radius - Math.hypot(x - centre, y - centre) + 0.5));
      const at = y * stride + 1 + x * 4; // each scanline starts with a filter byte (0 = none)
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
      raw[at + 3] = Math.round(edge * 255);
    }
  }

  const chunk = (name, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { LogoError, loadLogo, sniffType, isSvg, samplePng, defaultRasterizer };
