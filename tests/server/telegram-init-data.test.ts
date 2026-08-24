import { describe, it, expect } from 'vitest';
import { verifyInitData } from '../../src/server/telegram-init-data';
import { signInitData, signUserInitData } from '../test-helpers';

describe('verifyInitData', () => {
  const botToken = 'test-token-123';

  it('accepts a validly signed payload', () => {
    const initData = signUserInitData(42, 'alice', botToken);
    expect(verifyInitData(initData, botToken)).toEqual({ telegramId: 42, username: 'alice' });
  });

  it('rejects a tampered payload', () => {
    const initData = signUserInitData(42, 'alice', botToken);
    const tampered = initData.replace('alice', 'mallory');
    expect(verifyInitData(tampered, botToken)).toBeNull();
  });

  it('rejects a payload signed with a different bot token', () => {
    const initData = signUserInitData(42, 'alice', botToken);
    expect(verifyInitData(initData, 'other-token')).toBeNull();
  });

  it('rejects a payload with no hash', () => {
    expect(verifyInitData(signInitData({ user: '{}' }, ''), botToken)).toBeNull();
  });
});
