#!/usr/bin/env node

/**
 * Disabled bootstrap path.
 *
 * This script used Crawdad's removed arbitrary container exec endpoint to
 * write directly into an agent workspace. MCP configuration must now go
 * through an explicit provisioning path that stores secrets in the encrypted
 * agent secret store and hydrates them on container startup.
 */

console.error("configure-mcp.mjs is disabled: arbitrary container exec has been removed.");
console.error("Use the encrypted agent secret provisioning flow instead.");
process.exit(1);
