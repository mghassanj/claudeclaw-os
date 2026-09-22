// Per-worker setup for the whatsapp/ test suite. See ../../src/test-guard.ts.
import { assertSafeTestEnvironment, sandboxTestDirs } from "../../src/test-guard.js";

assertSafeTestEnvironment();
sandboxTestDirs();
