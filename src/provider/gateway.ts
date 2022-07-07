import urljoin from 'url-join';

import { ONE, StarknetChainId, ZERO } from '../constants';
import { CompiledContract, GetTransactionStatusResponse } from '../types';
import { Gateway } from '../types/api/gateway';
import { getSelectorFromName } from '../utils/hash';
import { parse, parseAlwaysAsBig, stringify } from '../utils/json';
import { BigNumberish, bigNumberishArrayToDecimalStringArray, toBN, toHex } from '../utils/number';
import { compressProgram, randomAddress } from '../utils/stark';
import {
  CallContractResponse,
  DeclareContractResponse,
  DeployContractResponse,
  FeeEstimateResponse,
  FunctionCall,
  GetBlockResponse,
  GetTransactionReceiptResponse,
  GetTransactionResponse,
  InvokeContractResponse,
  Provider,
} from './abstractProvider';
import { ProviderOptions } from './default';
import { GatewayError, HttpError } from './errors';
import { GatewayAPIResponseParser } from './gatewayParser';
import { BlockIdentifier, getFormattedBlockIdentifier } from './utils';

type NetworkName = 'mainnet-alpha' | 'goerli-alpha';

function wait(delay: number) {
  return new Promise((res) => {
    setTimeout(res, delay);
  });
}

function isEmptyQueryObject(obj?: Record<any, any>): obj is undefined {
  return (
    obj === undefined ||
    Object.keys(obj).length === 0 ||
    (Object.keys(obj).length === 1 &&
      Object.entries(obj).every(([k, v]) => k === 'blockIdentifier' && v === null))
  );
}

export class GatewayProvider implements Provider {
  public baseUrl: string;

  public feederGatewayUrl: string;

  public gatewayUrl: string;

  public chainId: StarknetChainId;

  private responseParser = new GatewayAPIResponseParser();

  constructor(optionsOrProvider: ProviderOptions = { network: 'goerli-alpha' }) {
    if ('network' in optionsOrProvider) {
      this.baseUrl = GatewayProvider.getNetworkFromName(optionsOrProvider.network);
      this.chainId = GatewayProvider.getChainIdFromBaseUrl(this.baseUrl);
      this.feederGatewayUrl = urljoin(this.baseUrl, 'feeder_gateway');
      this.gatewayUrl = urljoin(this.baseUrl, 'gateway');
    } else {
      this.baseUrl = optionsOrProvider.baseUrl;
      this.feederGatewayUrl =
        optionsOrProvider.feederGatewayUrl ?? urljoin(this.baseUrl, 'feeder_gateway');
      this.gatewayUrl = optionsOrProvider.gatewayUrl ?? urljoin(this.baseUrl, 'gateway');
      this.chainId =
        optionsOrProvider.chainId ??
        GatewayProvider.getChainIdFromBaseUrl(optionsOrProvider.baseUrl);
    }
  }

  protected static getNetworkFromName(name: NetworkName) {
    switch (name) {
      case 'mainnet-alpha':
        return 'https://alpha-mainnet.starknet.io';
      case 'goerli-alpha':
      default:
        return 'https://alpha4.starknet.io';
    }
  }

  protected static getChainIdFromBaseUrl(baseUrl: string): StarknetChainId {
    try {
      const url = new URL(baseUrl);
      if (url.host.includes('mainnet.starknet.io')) {
        return StarknetChainId.MAINNET;
      }
    } catch {
      // eslint-disable-next-line no-console
      console.error(`Could not parse baseUrl: ${baseUrl}`);
    }
    return StarknetChainId.TESTNET;
  }

  private getFetchUrl(endpoint: keyof Gateway.Endpoints) {
    const gatewayUrlEndpoints = ['add_transaction'];

    return gatewayUrlEndpoints.includes(endpoint) ? this.gatewayUrl : this.feederGatewayUrl;
  }

  private getFetchMethod(endpoint: keyof Gateway.Endpoints) {
    const postMethodEndpoints = ['add_transaction', 'call_contract', 'estimate_fee'];

    return postMethodEndpoints.includes(endpoint) ? 'POST' : 'GET';
  }

  private getQueryString(query?: Record<string, any>): string {
    if (isEmptyQueryObject(query)) {
      return '';
    }
    const queryString = Object.entries(query)
      .map(([key, value]) => {
        if (key === 'blockIdentifier') {
          return `${getFormattedBlockIdentifier(value)}`;
        }
        return `${key}=${value}`;
      })
      .join('&');

    return `?${queryString}`;
  }

  private getHeaders(method: 'POST' | 'GET'): Record<string, string> | undefined {
    if (method === 'POST') {
      return {
        'Content-Type': 'application/json',
      };
    }
    return undefined;
  }

  // typesafe fetch
  protected async fetchEndpoint<T extends keyof Gateway.Endpoints>(
    endpoint: T,
    // typescript type magiuc to create a nice fitting function interface
    ...[query, request]: Gateway.Endpoints[T]['QUERY'] extends never
      ? Gateway.Endpoints[T]['REQUEST'] extends never
        ? [] // when no query and no request is needed, we can omit the query and request parameters
        : [undefined, Gateway.Endpoints[T]['REQUEST']]
      : Gateway.Endpoints[T]['REQUEST'] extends never
      ? [Gateway.Endpoints[T]['QUERY']] // when no request is needed, we can omit the request parameter
      : [Gateway.Endpoints[T]['QUERY'], Gateway.Endpoints[T]['REQUEST']] // when both query and request are needed, we cant omit anything
  ): Promise<Gateway.Endpoints[T]['RESPONSE']> {
    const baseUrl = this.getFetchUrl(endpoint);
    const method = this.getFetchMethod(endpoint);
    const queryString = this.getQueryString(query);
    const headers = this.getHeaders(method);
    const url = urljoin(baseUrl, endpoint, queryString);

    try {
      const res = await fetch(url, {
        method,
        body: stringify(request),
        headers,
      });
      const textResponse = await res.text();
      if (!res.ok) {
        // This will allow user to handle contract errors
        let responseBody: any;
        try {
          responseBody = parse(textResponse);
        } catch {
          // if error parsing fails, return an http error
          throw new HttpError(res.statusText, res.status);
        }

        const errorCode = responseBody.code || ((responseBody as any)?.status_code as string); // starknet-devnet uses status_code instead of code; They need to fix that
        throw new GatewayError(responseBody.message, errorCode); // Caught locally, and re-thrown for the user
      }

      if (endpoint === 'estimate_fee') {
        return parseAlwaysAsBig(textResponse, (_, v) => {
          if (v && typeof v === 'bigint') {
            return toBN(v.toString());
          }
          return v;
        });
      }
      return parse(textResponse) as Gateway.Endpoints[T]['RESPONSE'];
    } catch (err) {
      // rethrow custom errors
      if (err instanceof GatewayError || err instanceof HttpError) {
        throw err;
      }
      if (err instanceof Error) {
        throw Error(`Could not ${method} from endpoint \`${url}\`: ${err.message}`);
      }
      throw err;
    }
  }

  public async callContract(
    { contractAddress, entryPointSelector, calldata = [] }: FunctionCall,
    blockIdentifier: BlockIdentifier = 'pending'
  ): Promise<CallContractResponse> {
    return this.fetchEndpoint(
      'call_contract',
      { blockIdentifier },
      {
        signature: [],
        contract_address: contractAddress,
        entry_point_selector: getSelectorFromName(entryPointSelector),
        calldata,
      }
    ).then(this.responseParser.parseCallContractResponse);
  }

  public async getBlock(blockIdentifier: BlockIdentifier = 'pending'): Promise<GetBlockResponse> {
    return this.fetchEndpoint('get_block', { blockIdentifier }).then(
      this.responseParser.parseGetBlockResponse
    );
  }

  public async getStorageAt(
    contractAddress: string,
    key: BigNumberish,
    blockIdentifier: BlockIdentifier = 'pending'
  ): Promise<BigNumberish> {
    return this.fetchEndpoint('get_storage_at', { blockIdentifier, contractAddress, key }) as any;
  }

  public async getTransaction(txHash: BigNumberish): Promise<GetTransactionResponse> {
    const txHashHex = toHex(toBN(txHash));
    return this.fetchEndpoint('get_transaction', { transactionHash: txHashHex }).then((value) =>
      this.responseParser.parseGetTransactionResponse(value)
    );
  }

  public async getTransactionReceipt(txHash: BigNumberish): Promise<GetTransactionReceiptResponse> {
    const txHashHex = toHex(toBN(txHash));
    return this.fetchEndpoint('get_transaction_receipt', { transactionHash: txHashHex }).then(
      this.responseParser.parseGetTransactionReceiptResponse
    );
  }

  public async getClassAt(
    contractAddress: string,
    blockIdentifier: BlockIdentifier = 'pending'
  ): Promise<any> {
    return this.fetchEndpoint('get_full_contract', { blockIdentifier, contractAddress }).then(
      (res) => {
        const parsedContract = typeof res === 'string' ? (parse(res) as CompiledContract) : res;
        return {
          ...parsedContract,
          program: compressProgram(parsedContract.program),
        };
      }
    );
  }

  public async invokeContract(
    functionInvocation: FunctionCall,
    signature?: BigNumberish[] | undefined,
    maxFee?: BigNumberish | undefined,
    version?: BigNumberish | undefined
  ): Promise<InvokeContractResponse> {
    return this.fetchEndpoint('add_transaction', undefined, {
      type: 'INVOKE_FUNCTION',
      contract_address: functionInvocation.contractAddress,
      entry_point_selector: getSelectorFromName(functionInvocation.entryPointSelector),
      calldata: bigNumberishArrayToDecimalStringArray(functionInvocation.calldata ?? []),
      signature: bigNumberishArrayToDecimalStringArray(signature ?? []),
      max_fee: maxFee,
      version,
    }).then(this.responseParser.parseInvokeContractResponse);
  }

  public async deployContract(
    compiledContract: CompiledContract | string,
    constructorCalldata?: BigNumberish[],
    salt?: BigNumberish | undefined
  ): Promise<DeployContractResponse> {
    const parsedContract =
      typeof compiledContract === 'string'
        ? (parse(compiledContract) as CompiledContract)
        : compiledContract;
    const contractDefinition = {
      ...parsedContract,
      program: compressProgram(parsedContract.program),
    };

    return this.fetchEndpoint('add_transaction', undefined, {
      type: 'DEPLOY',
      contract_address_salt: salt ?? randomAddress(),
      constructor_calldata: bigNumberishArrayToDecimalStringArray(constructorCalldata ?? []),
      contract_definition: contractDefinition,
    }).then(this.responseParser.parseDeployContractResponse);
  }

  public async declareContract(
    compiledContract: CompiledContract | string,
    _version?: BigNumberish | undefined
  ): Promise<DeclareContractResponse> {
    const parsedContract =
      typeof compiledContract === 'string'
        ? (parse(compiledContract) as CompiledContract)
        : compiledContract;
    const contractDefinition = {
      ...parsedContract,
      program: compressProgram(parsedContract.program),
    };

    return this.fetchEndpoint('add_transaction', undefined, {
      type: 'DECLARE',
      contract_class: contractDefinition,
      nonce: toHex(ZERO),
      signature: [],
      sender_address: toHex(ONE),
    }).then(this.responseParser.parseDeclareContractResponse);
  }

  public async estimateFee(
    request: FunctionCall,
    blockIdentifier: BlockIdentifier = 'pending',
    signature?: Array<string>
  ): Promise<FeeEstimateResponse> {
    return this.fetchEndpoint(
      'estimate_fee',
      { blockIdentifier },
      {
        contract_address: request.contractAddress,
        entry_point_selector: getSelectorFromName(request.entryPointSelector),
        calldata: bigNumberishArrayToDecimalStringArray(request.calldata ?? []),
        signature: bigNumberishArrayToDecimalStringArray(signature || []),
      }
    ).then(this.responseParser.parseFeeEstimateResponse);
  }

  /**
   * Gets the status of a transaction.
   *
   * [Reference](https://github.com/starkware-libs/cairo-lang/blob/f464ec4797361b6be8989e36e02ec690e74ef285/src/starkware/starknet/services/api/feeder_gateway/feeder_gateway_client.py#L48-L52)
   *
   * @param txHash
   * @returns the transaction status object { block_number, tx_status: NOT_RECEIVED | RECEIVED | PENDING | REJECTED | ACCEPTED_ONCHAIN }
   */
  public async getTransactionStatus(txHash: BigNumberish): Promise<GetTransactionStatusResponse> {
    const txHashHex = toHex(toBN(txHash));
    return this.fetchEndpoint('get_transaction_status', { transactionHash: txHashHex });
  }

  public async waitForTransaction(txHash: BigNumberish, retryInterval: number = 8000) {
    let onchain = false;

    while (!onchain) {
      // eslint-disable-next-line no-await-in-loop
      await wait(retryInterval);
      // eslint-disable-next-line no-await-in-loop
      const res = await this.getTransactionStatus(txHash);

      const successStates = ['ACCEPTED_ON_L1', 'ACCEPTED_ON_L2', 'PENDING'];
      const errorStates = ['REJECTED', 'NOT_RECEIVED'];

      if (successStates.includes(res.tx_status)) {
        onchain = true;
      } else if (errorStates.includes(res.tx_status)) {
        const message = res.tx_failure_reason
          ? `${res.tx_status}: ${res.tx_failure_reason.code}\n${res.tx_failure_reason.error_message}`
          : res.tx_status;
        const error = new Error(message) as Error & { response: GetTransactionStatusResponse };
        error.response = res;
        throw error;
      }
    }
  }
}
