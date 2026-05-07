import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

let _keypair: Keypair | null = null;

export function getWalletKeypair(): Keypair {
  if (_keypair) return _keypair;

  const raw = process.env["WALLET_PRIVATE_KEY"];
  if (!raw) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not set. Use the base58-encoded private key of the bot wallet."
    );
  }

  try {
    const secretKey = bs58.decode(raw);
    _keypair = Keypair.fromSecretKey(secretKey);
    return _keypair;
  } catch {
    throw new Error("WALLET_PRIVATE_KEY is not a valid base58 Solana private key.");
  }
}

export function getWalletAddress(): string {
  return getWalletKeypair().publicKey.toBase58();
}

// Sign a base64-encoded serialized transaction. Tries v0 first, falls back to legacy.
export function signTransaction(base64Tx: string): string {
  const txBytes = Buffer.from(base64Tx, "base64");
  const keypair = getWalletKeypair();

  try {
    const versionedTx = VersionedTransaction.deserialize(txBytes);
    versionedTx.sign([keypair]);
    return Buffer.from(versionedTx.serialize()).toString("base64");
  } catch {
    const legacyTx = Transaction.from(txBytes);
    legacyTx.partialSign(keypair);
    return legacyTx.serialize({ requireAllSignatures: false }).toString("base64");
  }
}
