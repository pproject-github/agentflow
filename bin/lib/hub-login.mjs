/**
 * agentflow login [--provider github|google]
 * agentflow logout
 */
import fs from "fs";
import os from "os";
import path from "path";
import chalk from "chalk";
import { log } from "./log.mjs";
import { getStoredSession, getUserProfile, loginWithBrowser } from "./hub.mjs";

export async function hubLogin(argv) {
  // Check if already logged in
  const existing = await getStoredSession();
  if (existing?.access_token) {
    const user = await getUserProfile(existing.access_token);
    if (user?.id) {
      log.info(chalk.green("✓") + " Already logged in as " + chalk.bold(user.email || user.id));
      log.info("  Use " + chalk.dim("agentflow logout") + " to sign out.");
      return;
    }
  }

  // Parse --provider flag
  let provider = "github";
  const providerIdx = argv.indexOf("--provider");
  if (providerIdx >= 0 && argv[providerIdx + 1]) {
    provider = argv[providerIdx + 1];
  }
  if (!["github", "google"].includes(provider)) {
    throw new Error("Invalid provider: " + provider + ". Use github or google.");
  }

  log.info("Logging in to AgentFlow Hub via " + chalk.bold(provider) + "...");
  const session = await loginWithBrowser(provider);

  // Fetch user info
  const user = await getUserProfile(session.access_token);
  if (user?.id) {
    log.info(chalk.green("✓") + " Logged in as " + chalk.bold(user.email || user.id));
  } else {
    log.info(chalk.green("✓") + " Login successful. Token stored.");
  }
}

export function hubLogout() {
  const configPath = path.join(os.homedir(), ".agentflow", "hub.json");
  try {
    fs.unlinkSync(configPath);
    log.info(chalk.green("✓") + " Logged out. Token removed.");
  } catch {
    log.info("Not logged in.");
  }
}
