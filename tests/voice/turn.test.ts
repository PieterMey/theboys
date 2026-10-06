// Track ④ Voice: ICE server sanitizing (node --test tests/voice/turn.test.ts). No network, no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeServers, withFallback } from '../../apps/server/src/voice/index.ts';

const CF_SAMPLE = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  {
    urls: [
      'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp',
    ],
    username: 'u', credential: 'c',
  },
];

test('drops port-53 URLs but keeps :5349 and :443', () => {
  const s = sanitizeServers(CF_SAMPLE);
  const urls = s.flatMap((e) => (Array.isArray(e.urls) ? e.urls : [e.urls]));
  assert.ok(!urls.some((u) => /:53(?![0-9])/.test(u)));
  assert.ok(urls.includes('turns:turn.cloudflare.com:5349?transport=tcp'));
  assert.ok(urls.includes('turns:turn.cloudflare.com:443?transport=tcp'));
  assert.equal(s[1].username, 'u');
  assert.equal(s[1].credential, 'c');
});

test('always includes the Cloudflare STUN fallback', () => {
  const s = withFallback(sanitizeServers([{ urls: 'turn:example.org:3478', username: 'a', credential: 'b' }]));
  assert.ok(s.some((e) => (Array.isArray(e.urls) ? e.urls : [e.urls]).includes('stun:stun.cloudflare.com:3478')));
});

test('ignores junk entries', () => {
  assert.deepEqual(sanitizeServers(null), []);
  assert.deepEqual(sanitizeServers([null, 3, { urls: 5 }, { urls: ['stun:x:53'] }]), []);
});
