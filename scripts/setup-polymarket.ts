#!/usr/bin/env ts-node
/**
 * One-time script to derive Polymarket CLOB API credentials from your wallet.
 * Run once: npx ts-node scripts/setup-polymarket.ts
 * Then copy the output lines into your .env file.
 */
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

dotenv.config();

const POLYMARKET_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

async function main(): Promise<void> {
  const privateKey = process.env['POLYMARKET_PRIVATE_KEY'];
  if (!privateKey || privateKey.startsWith('0x000000000000000000000000000000000000000000000000000000000000000')) {
    console.error('ERROR: Set a real POLYMARKET_PRIVATE_KEY in .env (not the dummy key).');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  const address = await wallet.getAddress();
  console.log(`\nDeriving credentials for wallet: ${address}`);

  // ethers v6 uses signTypedData; CLOB client expects _signTypedData (v5 interface)
  const signer = {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, unknown>
    ) => wallet.signTypedData(domain, types, value),
  };

  const client = new ClobClient(
    POLYMARKET_HOST,
    CHAIN_ID,
    signer as Parameters<typeof ClobClient>[2]
  );

  console.log('Contacting Polymarket API...\n');
  const creds = await client.createOrDeriveApiKey();

  console.log('=== Add these lines to your .env ===\n');
  console.log(`POLYMARKET_API_KEY=${creds.apiKey}`);
  console.log(`POLYMARKET_SECRET=${creds.secret}`);
  console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
  console.log('\n=====================================');
  console.log('Done. These credentials are tied to your wallet address.');
  console.log('Running this script again with the same wallet returns the same credentials.');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
