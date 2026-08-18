import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectStaticFailures,
  hasDestructiveXiaojingDataOperation,
  readPeMachine,
  validateIdentityContract,
} from './validate-windows-x64.mjs';

test('repository satisfies the Windows x64 static contract', () => {
  assert.deepEqual(collectStaticFailures(), []);
});

test('PE parser distinguishes x64 from unsupported machines', () => {
  const pe = Buffer.alloc(512);
  pe.write('MZ', 0, 'ascii');
  pe.writeUInt32LE(128, 0x3c);
  pe.write('PE\0\0', 128, 'ascii');
  pe.writeUInt16LE(0x8664, 132);
  assert.equal(readPeMachine(pe), 0x8664);
  pe.writeUInt16LE(0xaa64, 132);
  assert.equal(readPeMachine(pe), 0xaa64);
});

test('identity contract rejects an alternate architecture or product identity', () => {
  const failures = validateIdentityContract(
    { identity: { package: 'other' } },
    { name: 'other' },
    '[package]\nname = "other"',
    { productName: 'other', identifier: 'other' },
  );
  assert.ok(failures.length >= 4);
});

test('uninstall audit rejects deletion of the application data root', () => {
  assert.equal(
    hasDestructiveXiaojingDataOperation('RMDir /r "$LOCALAPPDATA\\Xiaojing"'),
    true,
  );
  assert.equal(
    hasDestructiveXiaojingDataOperation('; RMDir /r "$LOCALAPPDATA\\Xiaojing"'),
    false,
  );
});
