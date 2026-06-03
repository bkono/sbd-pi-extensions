// Re-export all techniques
export { stripAnsi, stripAnsiFast } from "./ansi.js";
export { filterBuildOutput, isBuildCommand } from "./build.js";
export { compressBuildToolsOutput, isBuildToolsCommand } from "./build-tools.js";
export { compressDockerOutput, isDockerCommand } from "./docker.js";
export { compressFileListingOutput, isFileListingCommand } from "./file-listing.js";
export { compactDiff, compactGitOutput, compactLog, compactStatus, isGitCommand } from "./git.js";
export { compressHttpOutput, isHttpCommand } from "./http-client.js";
export { aggregateLinterOutput, isLinterCommand } from "./linter.js";
export { compressPackageManagerOutput, isPackageManagerCommand } from "./package-manager.js";
export { aggregateTestOutput, isTestCommand } from "./test-output.js";
export { compressTransferOutput, isTransferCommand } from "./transfer.js";
export { truncate, truncateLines } from "./truncate.js";
