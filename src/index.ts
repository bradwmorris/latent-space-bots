function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function main(): void {
  requiredEnv("BOT_TOKEN_SIG");
  requiredEnv("BOT_TOKEN_SLOP");

  console.log("latent-space-bots bootstrap service started");
  console.log("Sig and Slop runtime wiring will be added next.");
}

main();
