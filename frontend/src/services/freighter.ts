import {
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
} from '@stellar/freighter-api';
import {
  Address,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { AppConfig, PledgeTransactionResult, WalletConnection } from '../types/campaign';

type AppErrorLike = Error & { code?: string };

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

function buildError(code: string, message: string): AppErrorLike {
  const error = new Error(message) as AppErrorLike;
  error.code = code;
  return error;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return fallback;
}

function getRpcServer(rpcUrl: string): rpc.Server {
  return new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
}

function networkLabel(passphrase: string | undefined): string {
  if (!passphrase) {
    return 'unknown network';
  }
  if (passphrase === TESTNET_PASSPHRASE) {
    return 'Stellar Testnet';
  }
  if (passphrase === MAINNET_PASSPHRASE) {
    return 'Stellar Mainnet';
  }
  return 'the configured network';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

const STROOPS_PER_XLM = 10_000_000;

export interface EstimatedFee {
  stroops: number;
  xlm: string;
}

function formatStroopsAsXlm(stroops: number): string {
  return (stroops / STROOPS_PER_XLM).toFixed(7).replace(/\.?0+$/, '');
}

/**
 * Derives the estimated network fee from a transaction that has already been
 * prepared from a Soroban simulation. The prepared transaction's fee covers the
 * inclusion fee plus the simulated resource fee, i.e. what the wallet will be
 * asked to pay. Returns null when the fee cannot be parsed so the UI can fall
 * back to a "Calculating..." state instead of showing a misleading value.
 */
function estimateFeeFromTransaction(transaction: { fee: string }): EstimatedFee | null {
  try {
    const feeStroops = Number(transaction.fee);
    if (!Number.isFinite(feeStroops) || feeStroops < 0) {
      return null;
    }
    return { stroops: feeStroops, xlm: formatStroopsAsXlm(feeStroops) };
  } catch {
    return null;
  }
}

export function amountToContractUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw buildError('INVALID_AMOUNT', 'Pledge amount must be greater than zero.');
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw buildError('INVALID_DECIMALS', 'Invalid contract amount decimals configuration.');
  }

  const factor = 10 ** decimals;
  const scaled = amount * factor;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-8) {
    throw buildError(
      'INVALID_AMOUNT_PRECISION',
      `Amount must use no more than ${decimals} decimal place${decimals === 1 ? '' : 's'}.`,
    );
  }

  return BigInt(rounded);
}

export async function connectFreighterWallet(
  expectedNetworkPassphrase: string,
): Promise<WalletConnection> {
  const connected = await isConnected();
  if (!connected) {
    throw buildError(
      'FREIGHTER_UNAVAILABLE',
      'Freighter was not detected. Install or unlock the extension and try again.',
    );
  }

  let publicKey: string;
  try {
    publicKey = await requestAccess();
  } catch (error) {
    throw buildError(
      'FREIGHTER_ACCESS_DENIED',
      getErrorMessage(error, 'Freighter access was rejected.'),
    );
  }

  let details:
    | {
        networkPassphrase: string;
        sorobanRpcUrl?: string;
      }
    | undefined;

  try {
    const networkDetails = await getNetworkDetails();
    details = {
      networkPassphrase: networkDetails.networkPassphrase,
      sorobanRpcUrl: networkDetails.sorobanRpcUrl,
    };
  } catch {
    details = undefined;
  }

  if (details?.networkPassphrase && details.networkPassphrase !== expectedNetworkPassphrase) {
    throw buildError(
      'FREIGHTER_NETWORK_MISMATCH',
      `Freighter is connected to ${networkLabel(details.networkPassphrase)}, but this app expects ${networkLabel(expectedNetworkPassphrase)}.`,
    );
  }

  return {
    publicKey,
    networkPassphrase: details?.networkPassphrase,
    sorobanRpcUrl: details?.sorobanRpcUrl,
  };
}

export interface ConfirmedTransaction extends PledgeTransactionResult {
  ledger?: number;
  latestLedger?: number;
}

const MAX_SEND_ATTEMPTS = 3;
const MAX_POLL_ATTEMPTS = 25;
const POLL_INTERVAL_MS = 1200;
// Allowance for clock skew between this browser and ledger close time.
const TIME_BOUNDS_GRACE_SECONDS = 30;

/**
 * Builds an error for a transaction that was handed to the network but whose
 * outcome is unknown. `submittedTransaction` lets a retry resume the same
 * envelope (same hash) instead of building a second transaction.
 */
function buildSubmittedError(
  code: string,
  message: string,
  signedTransaction: Transaction,
): AppErrorLike & { transactionHash: string; submittedTransaction: string } {
  return Object.assign(buildError(code, message), {
    transactionHash: transactionHashHex(signedTransaction),
    submittedTransaction: signedTransaction.toXDR(),
  });
}

function transactionHashHex(transaction: Transaction): string {
  return Array.from(transaction.hash(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hasReachedNetwork(server: rpc.Server, transactionHash: string): Promise<boolean> {
  const existing = await server.getTransaction(transactionHash).catch(() => null);
  return Boolean(existing && existing.status !== rpc.Api.GetTransactionStatus.NOT_FOUND);
}

async function waitForTransaction(
  server: rpc.Server,
  signedTransaction: Transaction,
): Promise<ConfirmedTransaction> {
  const transactionHash = transactionHashHex(signedTransaction);
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    // A transient RPC error while polling says nothing about the transaction.
    const result = await server.getTransaction(transactionHash).catch(() => null);
    if (result?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        transactionHash,
        confirmedAt: result.createdAt,
        ledger: result.ledger,
        latestLedger: result.latestLedger,
      };
    }
    if (result?.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw buildError(
        'TRANSACTION_FAILED',
        `The network rejected transaction ${transactionHash}.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw buildSubmittedError(
    'TRANSACTION_TIMEOUT',
    `Transaction ${transactionHash} was submitted but is not confirmed yet. Retry to keep checking it; it will not be submitted twice.`,
    signedTransaction,
  );
}

/**
 * Submits a signed transaction and waits for a final ledger result.
 *
 * Status mapping:
 * - PENDING / DUPLICATE → poll until SUCCESS (confirmed) or FAILED (failed).
 * - TRY_AGAIN_LATER and transport errors → resend the *same* envelope, so the
 *   network can include it at most once; when attempts run out → retryable.
 * - ERROR → TRANSACTION_REJECTED carrying the Stellar result code (e.g.
 *   txBadSeq, txInsufficientBalance), unless an earlier ambiguous attempt
 *   already landed, in which case the original is polled instead.
 */
export async function sendAndConfirmTransaction(
  server: rpc.Server,
  signedTransaction: Transaction,
): Promise<ConfirmedTransaction> {
  const transactionHash = transactionHashHex(signedTransaction);

  for (let attempt = 1; ; attempt += 1) {
    let sendResult: rpc.Api.SendTransactionResponse;
    try {
      sendResult = await server.sendTransaction(signedTransaction);
    } catch (error) {
      if (attempt >= MAX_SEND_ATTEMPTS) {
        throw buildSubmittedError(
          'SUBMISSION_RETRY',
          `${getErrorMessage(error, 'Soroban RPC could not be reached.')} Retry to resubmit the same transaction.`,
          signedTransaction,
        );
      }
      await sleep(POLL_INTERVAL_MS * attempt);
      if (await hasReachedNetwork(server, transactionHash)) {
        return waitForTransaction(server, signedTransaction);
      }
      continue;
    }

    if (sendResult.status === 'PENDING' || sendResult.status === 'DUPLICATE') {
      return waitForTransaction(server, signedTransaction);
    }

    if (sendResult.status === 'TRY_AGAIN_LATER') {
      if (attempt >= MAX_SEND_ATTEMPTS) {
        throw buildSubmittedError(
          'SUBMISSION_RETRY',
          'Soroban RPC is busy and asked to retry later. Retry to resubmit the same transaction.',
          signedTransaction,
        );
      }
      await sleep(POLL_INTERVAL_MS * attempt);
      continue;
    }

    if (attempt > 1 && (await hasReachedNetwork(server, transactionHash))) {
      return waitForTransaction(server, signedTransaction);
    }

    let resultCode: string | undefined;
    try {
      // `errorResult` is an xdr.TransactionResult; its code name is e.g. txBadSeq.
      const errorResult = sendResult.errorResult as
        { result: () => { switch: () => { name: string } } } | undefined;
      resultCode = errorResult?.result().switch().name;
    } catch {
      resultCode = undefined;
    }
    throw Object.assign(
      buildError(
        'TRANSACTION_REJECTED',
        `Soroban RPC rejected transaction ${transactionHash}${resultCode ? ` (${resultCode})` : ''}.`,
      ),
      { resultCode, transactionHash },
    );
  }
}

/**
 * Resumes a transaction from a previous attempt (see `submittedTransaction` on
 * retryable errors) without building a new one. If it never reached the
 * ledger and its time bounds have passed, it can no longer land, so a
 * TRANSACTION_EXPIRED error tells the caller a fresh transaction is safe.
 */
export async function resumeSubmittedTransaction(
  rpcUrl: string,
  networkPassphrase: string,
  submittedTransaction: string,
): Promise<ConfirmedTransaction> {
  const signedTransaction = TransactionBuilder.fromXDR(
    submittedTransaction,
    networkPassphrase,
  ) as Transaction;
  const server = getRpcServer(rpcUrl);
  const transactionHash = transactionHashHex(signedTransaction);

  let existing: rpc.Api.GetTransactionResponse;
  try {
    existing = await server.getTransaction(transactionHash);
  } catch (error) {
    throw buildSubmittedError(
      'RPC_UNAVAILABLE',
      getErrorMessage(error, 'Soroban RPC could not be reached. Retry in a moment.'),
      signedTransaction,
    );
  }

  if (existing.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
    return waitForTransaction(server, signedTransaction);
  }

  const maxTime = Number(signedTransaction.timeBounds?.maxTime ?? 0);
  if (maxTime > 0 && Date.now() / 1000 > maxTime + TIME_BOUNDS_GRACE_SECONDS) {
    throw buildError(
      'TRANSACTION_EXPIRED',
      `Transaction ${transactionHash} expired before reaching the network. Retry to submit a new one.`,
    );
  }

  return sendAndConfirmTransaction(server, signedTransaction);
}

export async function submitFreighterClaim(params: {
  campaignId: string;
  creator: string;
  config: AppConfig;
  onPreview?: (preview: {
    operation: string;
    amount?: number;
    assetCode?: string;
    contract: string;
    xdr: string;
    estimatedFee?: EstimatedFee;
  }) => Promise<boolean>;
}): Promise<ConfirmedTransaction> {
  const { campaignId, creator, config } = params;

  if (!config.contractId || !config.sorobanRpcUrl) {
    throw buildError(
      'CONFIG_MISSING',
      'Wallet signing is not configured yet. Set CONTRACT_ID and SOROBAN_RPC_URL on the backend.',
    );
  }

  const server = getRpcServer(config.sorobanRpcUrl);
  const sourceAccount = await server.getAccount(creator).catch((error) => {
    throw buildError(
      'SOURCE_ACCOUNT_LOAD_FAILED',
      getErrorMessage(error, 'Unable to load the creator account from Soroban RPC.'),
    );
  });

  const operation = new Contract(config.contractId).call(
    'claim',
    nativeToScVal(BigInt(campaignId), { type: 'u64' }),
    Address.fromString(creator).toScVal(),
  );

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction).catch((error) => {
    throw buildError(
      'SIMULATION_FAILED',
      getErrorMessage(error, 'Unable to simulate the claim transaction.'),
    );
  });

  if ('error' in simulation) {
    throw buildError('SIMULATION_FAILED', `Simulation failed: ${simulation.error}`);
  }

  if ('restorePreamble' in simulation) {
    throw buildError(
      'STATE_RESTORE_REQUIRED',
      'The contract state is archived and must be restored before claiming.',
    );
  }

  let preparedTransaction;
  try {
    preparedTransaction = rpc.assembleTransaction(transaction, simulation as any).build();
  } catch (error) {
    throw buildError(
      'SIMULATION_PREPARE_FAILED',
      getErrorMessage(error, 'Failed to prepare the simulated claim transaction.'),
    );
  }

  if (params.onPreview) {
    const isApproved = await params.onPreview({
      operation: 'claim',
      contract: config.contractId,
      xdr: preparedTransaction.toXDR(),
      estimatedFee: estimateFeeFromTransaction(preparedTransaction) ?? undefined,
    });
    if (!isApproved) {
      throw buildError('USER_CANCELLED', 'User cancelled the transaction from the preview panel.');
    }
  }

  let signedXdr: string;
  try {
    signedXdr = await signTransaction(preparedTransaction.toXDR(), {
      accountToSign: creator,
      networkPassphrase: config.networkPassphrase,
    });
  } catch (error) {
    throw buildError(
      'SIGNING_FAILED',
      getErrorMessage(error, 'Freighter rejected or failed to sign the claim transaction.'),
    );
  }

  if (!signedXdr) {
    throw buildError('SIGNING_FAILED', 'Freighter did not return a signed transaction.');
  }

  const signedTransaction = TransactionBuilder.fromXDR(
    signedXdr,
    config.networkPassphrase,
  ) as Transaction;
  return sendAndConfirmTransaction(server, signedTransaction);
}

export async function submitFreighterPledge(params: {
  campaignId: string;
  contributor: string;
  amount: number;
  assetCode: string;
  config: AppConfig;
  onPreview?: (preview: {
    operation: string;
    amount?: number;
    assetCode?: string;
    contract: string;
    xdr: string;
    estimatedFee?: EstimatedFee;
  }) => Promise<boolean>;
}): Promise<ConfirmedTransaction> {
  const { campaignId, contributor, amount, config, assetCode } = params;

  if (!config.contractId || !config.sorobanRpcUrl) {
    throw buildError(
      'CONFIG_MISSING',
      'Wallet signing is not configured yet. Set CONTRACT_ID and SOROBAN_RPC_URL on the backend.',
    );
  }

  const server = getRpcServer(config.sorobanRpcUrl);
  const amountUnits = amountToContractUnits(amount, config.contractAmountDecimals);
  const tokenAddress = config.assetAddresses[assetCode.toUpperCase()];

  if (!tokenAddress) {
    throw buildError(
      'ASSET_NOT_CONFIGURED',
      `Soroban contract address for ${assetCode} is not configured.`,
    );
  }

  const sourceAccount = await server.getAccount(contributor).catch((error) => {
    throw buildError(
      'SOURCE_ACCOUNT_LOAD_FAILED',
      getErrorMessage(error, 'Unable to load the contributor account from Soroban RPC.'),
    );
  });

  const operation = new Contract(config.contractId).call(
    'contribute',
    nativeToScVal(BigInt(campaignId), { type: 'u64' }),
    Address.fromString(contributor).toScVal(),
    Address.fromString(tokenAddress).toScVal(),
    nativeToScVal(amountUnits, { type: 'i128' }),
  );

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(transaction).catch((error) => {
    throw buildError(
      'SIMULATION_FAILED',
      getErrorMessage(error, 'Unable to simulate the pledge transaction.'),
    );
  });

  if ('error' in simulation) {
    throw buildError('SIMULATION_FAILED', `Simulation failed: ${simulation.error}`);
  }

  if ('restorePreamble' in simulation) {
    throw buildError(
      'STATE_RESTORE_REQUIRED',
      'The contract state is archived and must be restored before pledging.',
    );
  }

  let preparedTransaction;
  try {
    preparedTransaction = rpc.assembleTransaction(transaction, simulation as any).build();
  } catch (error) {
    throw buildError(
      'SIMULATION_PREPARE_FAILED',
      getErrorMessage(error, 'Failed to prepare the simulated transaction.'),
    );
  }

  if (params.onPreview) {
    const isApproved = await params.onPreview({
      operation: 'contribute',
      amount: params.amount,
      assetCode: params.assetCode,
      contract: config.contractId,
      xdr: preparedTransaction.toXDR(),
      estimatedFee: estimateFeeFromTransaction(preparedTransaction) ?? undefined,
    });
    if (!isApproved) {
      throw buildError('USER_CANCELLED', 'User cancelled the transaction from the preview panel.');
    }
  }

  let signedXdr: string;
  try {
    signedXdr = await signTransaction(preparedTransaction.toXDR(), {
      accountToSign: contributor,
      networkPassphrase: config.networkPassphrase,
    });
  } catch (error) {
    throw buildError(
      'SIGNING_FAILED',
      getErrorMessage(error, 'Freighter rejected or failed to sign the transaction.'),
    );
  }

  if (!signedXdr) {
    throw buildError('SIGNING_FAILED', 'Freighter did not return a signed transaction.');
  }

  const signedTransaction = TransactionBuilder.fromXDR(
    signedXdr,
    config.networkPassphrase,
  ) as Transaction;
  return sendAndConfirmTransaction(server, signedTransaction);
}

export function watchFreighterAccount(onChange: (address: string) => void): () => void {
  let lastAddress = '';
  const id = window.setInterval(async () => {
    try {
      const address = await requestAccess();
      if (address !== lastAddress) {
        lastAddress = address;
        onChange(address);
      }
    } catch {
      // extension unavailable or locked — treat as disconnected
      if (lastAddress !== '') {
        lastAddress = '';
        onChange('');
      }
    }
  }, 2000);
  return () => window.clearInterval(id);
}
