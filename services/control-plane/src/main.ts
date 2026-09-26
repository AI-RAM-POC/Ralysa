#!/usr/bin/env node
// The control-plane executable (bin `control-plane`, the image's entry point). The entry points
// and their usage are in commands.ts (F-002 design §2.1, §3.8).
import { main } from './commands.js';

process.exitCode = await main(process.argv.slice(2));
