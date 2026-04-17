/**
 * Unit tests for the SSRF guard used by skill_install (SEC-C2).
 *
 * These tests focus on the pure IP-classification helper so they run
 * without touching DNS or the network. Integration of the guard with
 * installSkill is covered indirectly via the existing skills test suite.
 */

import { isForbiddenIp } from '../../mcp/tools/skills/url-guard';

describe('SEC-C2: isForbiddenIp blocks SSRF targets', () => {
  const blocked: Array<[string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.255.0.1', 'loopback range'],
    ['10.0.0.1', 'RFC1918 10/8'],
    ['10.254.1.2', 'RFC1918 10/8'],
    ['172.16.0.1', 'RFC1918 172.16/12 lower edge'],
    ['172.31.255.254', 'RFC1918 172.16/12 upper edge'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['169.254.169.254', 'AWS/GCP IMDS'],
    ['169.254.1.1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'CGNAT 100.64/10'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd00::1', 'IPv6 ULA'],
    ['fc00::abcd', 'IPv6 ULA'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped IMDS'],
    ['not-an-ip', 'garbage (fail closed)'],
  ];

  const allowed: Array<[string, string]> = [
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['140.82.112.4', 'github.com'],
    ['2606:4700:4700::1111', 'Cloudflare v6'],
    ['172.15.0.1', 'outside RFC1918 172.16/12'],
    ['172.32.0.1', 'outside RFC1918 172.16/12'],
  ];

  for (const [ip, label] of blocked) {
    it(`blocks ${label} (${ip})`, () => {
      expect(isForbiddenIp(ip)).toBe(true);
    });
  }

  for (const [ip, label] of allowed) {
    it(`allows ${label} (${ip})`, () => {
      expect(isForbiddenIp(ip)).toBe(false);
    });
  }
});
