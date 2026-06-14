import assert from 'node:assert/strict';
import { hostToolsAllowedFromSearch } from '../ui/src/workspaceCapabilities.ts';

assert.equal(hostToolsAllowedFromSearch(''), true);
assert.equal(hostToolsAllowedFromSearch('?tf_host_tools=1'), true);
assert.equal(hostToolsAllowedFromSearch('?tf_host_tools=true'), true);
assert.equal(hostToolsAllowedFromSearch('?tf_host_tools=0'), false);
assert.equal(hostToolsAllowedFromSearch('?tf_host_tools=false'), false);
assert.equal(hostToolsAllowedFromSearch('?tf_host_tools=no'), false);

console.log('workspace-capabilities ok');
