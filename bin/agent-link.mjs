#!/usr/bin/env node
import { runCLI } from './startup.mjs';

process.exitCode = await runCLI(process.argv.slice(2));
