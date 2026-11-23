#!/usr/bin/env node
// Stand-in for kane-cli in tests. Prints a fixture and exits with the requested code.
import { readFileSync } from "node:fs";
const fixture = process.env.FAKE_KANE_FIXTURE;
if (fixture) process.stdout.write(readFileSync(fixture, "utf8"));
process.exit(Number(process.env.FAKE_KANE_EXIT ?? "0"));
