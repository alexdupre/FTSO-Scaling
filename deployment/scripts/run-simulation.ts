import { loadAccounts } from "../tasks/common";
import { getWeb3 } from "../../src/web3-utils";
import { ChildProcess, execSync, spawn } from "child_process";
import { retry } from "../../src/utils/retry";
import { sleepFor } from "../../src/time-utils";
import { promisify } from "util";
import Web3 from "web3";

const DATA_PROVIDER_COUNT = 3;
const RPC = "http://127.0.0.1:8545";

/**
 * This script is used to run a local simulation of the FTSO on the local hardhat network.
 * It deploys contracts and starts a cluster of data providers.
 */
async function main() {
  const childProcesses = [];

  try {
    childProcesses.push(startNetwork());

    const web3 = await retry(() => getWeb3(RPC), 3, 1000);

    setIntervalMining(web3);

    const accounts = loadAccounts(web3);
    const envConfig = {
      ...process.env,
      CHAIN_CONFIG: "local",
      DEPLOYER_PRIVATE_KEY: accounts[0].privateKey,
    };
    process.env = envConfig;

    deployContracts(envConfig);
    childProcesses.push(startAdminDaemon());

    const startId = 1; // 0 is reserved for governance account
    for (let i = startId; i <= DATA_PROVIDER_COUNT; i++) {
      childProcesses.push(startDataProvider(i));
      await sleepFor(1000);
    }

    while (true) {
      await sleepFor(10_000);
    }
  } catch (e) {
    childProcesses.forEach(p => p.kill());
    throw e;
  }
}

function deployContracts(envConfig: any) {
  execSync("yarn c && yarn hardhat deploy-contracts --network local", { stdio: "inherit", env: envConfig });
}

function startNetwork(): ChildProcess {
  const process = spawn("yarn", ["hardhat", "node"]);
  process.stderr.on("data", function (data) {
    console.error(`Hardhat error: ${data}`);
  });
  process.on("close", function (code) {
    throw new Error(`Hardhat process exited with code ${code}, aborting.`);
  });
  return process;
}

function startAdminDaemon(): ChildProcess {
  const process = spawn("yarn", ["hardhat", "run-admin-daemon", "--network", "local"]);
  process.stdout.on("data", function (data) {
    console.log(`[Admin daemon]: ${data}`);
  });
  process.stderr.on("data", function (data) {
    console.log(`[Admin daemon] ERROR: ${data}`);
  });
  process.on("close", function (code) {
    throw new Error(`Admin daemon exited with code ${code}, aborting.`);
  });
  return process;
}

function startDataProvider(id: number): ChildProcess {
  const process = spawn("yarn", ["ts-node", "deployment/scripts/run-data-provider.ts", id.toString()]);
  process.stdout.on("data", function (data) {
    console.log(`[Provider ${id}]: ${data}`);
  });
  process.stderr.on("data", function (data) {
    console.log(`[Provider ${id}] ERROR: ${data}`);
  });
  process.on("close", function (code) {
    console.log("closing code: " + code);
    throw Error(`Provider ${id} exited with code ${code}`);
  });
  return process;
}

/** Configures Hardhat to automatically mine blocks in the specified interval. */
export async function setIntervalMining(web3: Web3, interval: number = 1000) {
  await promisify((web3.currentProvider as any).send.bind(web3.currentProvider))({
    jsonrpc: "2.0",
    method: "evm_setAutomine",
    params: [false],
    id: new Date().getTime(),
  });

  await promisify((web3.currentProvider as any).send.bind(web3.currentProvider))({
    jsonrpc: "2.0",
    method: "evm_setIntervalMining",
    params: [interval],
    id: new Date().getTime(),
  });
}

main();