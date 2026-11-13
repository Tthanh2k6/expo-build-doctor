import { loadProject, extractSdkMajor, resolveEasProfile, ConfigReadError } from './loader.js';
import { runChecks } from './rules.js';
import { formatTextReport, parseArgs, shouldFail, runCli } from './cli.js';

/**
 * Loads and analyzes an Expo project directory or explicit config paths programmatically.
 */
export function analyzeProject(options = {}) {
  const project = loadProject(options);
  return runChecks(project, options);
}

export {
  ConfigReadError,
  extractSdkMajor,
  formatTextReport,
  loadProject,
  parseArgs,
  resolveEasProfile,
  runChecks,
  runCli,
  shouldFail,
};
