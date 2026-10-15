import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const aliases = [
  ["DATABASE_URL", "veylora_DATABASE_URL"],
  ["DATABASE_URL_UNPOOLED", "veylora_DATABASE_URL_UNPOOLED"],
];

export function applyNeonEnvironmentAliases(environment) {
  for (const [target, alias] of aliases) {
    if (!environment[target]?.trim() && environment[alias]?.trim()) {
      environment[target] = environment[alias];
    }
  }

  return environment;
}

function run(command, args) {
  if (!command) {
    console.error("A command is required.");
    process.exitCode = 2;
    return;
  }

  const child = spawn(command, args, {
    env: applyNeonEnvironmentAliases({ ...process.env }),
    stdio: "inherit",
  });

  child.on("error", () => {
    console.error("Unable to start the requested command.");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv[2], process.argv.slice(3));
}