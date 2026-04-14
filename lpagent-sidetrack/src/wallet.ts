/**
 * Solana wallet utilities for signing LP Agent transactions.
 *
 * The bot wallet private key is loaded from WALLET_PRIVATE_KEY (base58 encoded).
 * In production, replace this with a proper secrets manager (AWS Secrets Manager,
 * HashiCorp Vault, etc.) — never commit private keys.
 */

import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

let _keypair: Keypair | null = null;

/**
 * Load the bot wallet keypair from the WALLET_PRIVATE_KEY env var.
 * Throws if the env var is not set or the key is invalid.
 */
export function getWalletKeypair(): Keypair {
  if (_keypair) return _keypair;

  const raw = process.env["WALLET_PRIVATE_KEY"];
  if (!raw) {
    throw new Error(
      "WALLET_PRIVATE_KEY environment variable is not set. " +
        "Set it to the base58-encoded private key of the bot wallet."
    );
  }

  try {
    const secretKey = bs58.decode(raw);
    _keypair = Keypair.fromSecretKey(secretKey);
    return _keypair;
  } catch {
    throw new Error(
      "WALLET_PRIVATE_KEY is not a valid base58-encoded Solana private key."
    );
  }
}

/**
 * Returns the bot wallet's public key as a base58 string.
 * Safe to call at startup to log/verify the configured wallet.
 */
export function getWalletAddress(): string {
  return getWalletKeypair().publicKey.toBase58();
}

/**
 * Sign a base64-encoded serialized transaction (legacy or versioned) with the bot wallet.
 * Returns a base64-encoded signed transaction ready for submission.
 */
export function signTransaction(base64Tx: string): string {
  const txBytes = Buffer.from(base64Tx, "base64");
  const keypair = getWalletKeypair();

  // Try versioned transaction first (v0), fall back to legacy
  try {
    const versionedTx = VersionedTransaction.deserialize(txBytes);
    versionedTx.sign([keypair]);
    return Buffer.from(versionedTx.serialize()).toString("base64");
  } catch {
    const legacyTx = Transaction.from(txBytes);
    legacyTx.partialSign(keypair);
    return legacyTx
      .serialize({ requireAllSignatures: false })
      .toString("base64");
  }
}
