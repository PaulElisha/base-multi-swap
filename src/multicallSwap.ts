import { ethers } from "ethers";
import { abi as ISwapRouter } from "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json";
import { abi as IERC20 } from '../src/abi/IERC20.json';
import { abi as IUniswapV3Factory } from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json';
import { SwapParam } from '../src/interfaces/SwapParam'


export class MulticallSwap {
    private signer: ethers.Signer;
    private swapRouterContract: ethers.Contract;
    private factoryContract: ethers.Contract;
    private readonly UNISWAP_ROUTER_ADDRESS: string;
    private readonly UNISWAP_FACTORY_ADDRESS: string; // Update to DragonSwap factory address if different

    constructor(signer: ethers.Signer, routerAddress: string, factoryAddress: string) {
        this.signer = signer;
        this.UNISWAP_ROUTER_ADDRESS = routerAddress;
        this.UNISWAP_FACTORY_ADDRESS = factoryAddress;
        this.swapRouterContract = new ethers.Contract(
            this.UNISWAP_ROUTER_ADDRESS,
            ISwapRouter,
            this.signer
        );
        this.factoryContract = new ethers.Contract(
            this.UNISWAP_FACTORY_ADDRESS,
            IUniswapV3Factory,
            this.signer
        );
    }

    private async needsApproval(amountIn: bigint, tokenIn: string): Promise<boolean> {
        const tokenContract = new ethers.Contract(tokenIn, IERC20, this.signer);
        const allowance = await tokenContract.allowance(await this.signer.getAddress(), this.UNISWAP_ROUTER_ADDRESS);
        console.log("Allowance is", allowance.toString());

        if (allowance >= amountIn) {
            await this.approveToken(BigInt(0), tokenIn);
            throw new Error(`Removed Approval for token: ${tokenIn}.`);
        }
        return allowance < amountIn;
    }

    private async approveToken(amountIn: bigint, tokenIn: string): Promise<void> {
        const tokenContract = new ethers.Contract(tokenIn, IERC20, this.signer);
        const approvalTx = await tokenContract.approve(this.UNISWAP_ROUTER_ADDRESS, amountIn);
        console.log(`Approval transaction sent: ${approvalTx.hash} for ${amountIn}`);
        await approvalTx.wait();
        console.log(`Approval confirmed: ${approvalTx.hash} for ${amountIn}`);
    }

    private async hasSufficientBalance(tokenIn: string, amountIn: bigint): Promise<boolean> {
        const tokenContract = new ethers.Contract(tokenIn, IERC20, this.signer);
        const balance = await tokenContract.balanceOf(await this.signer.getAddress());
        return balance > amountIn;
    }

    private validateDeadline(deadline: number): boolean {
        return deadline > Math.floor(Date.now() / 1000);
    }

    /**
 * Calculate slippage-adjusted amountOutMinimum
 * @param estimatedAmountOut - Expected amount out from the swap
 * @param slippageTolerance - User-defined slippage tolerance (e.g., 1% = 0.01)
 * @returns Amount out minimum after applying slippage tolerance
 */
    private calculateSlippage(estimatedAmountOut: number, slippageTolerance: number): bigint {
        const slippageAmount = (BigInt(estimatedAmountOut) * BigInt(Math.floor(slippageTolerance * 100))) / BigInt(10000);
        return BigInt(estimatedAmountOut) - slippageAmount; // Reduce by slippage tolerance
    }


    private async getPoolFee(tokenIn: string, tokenOut: string): Promise<number> {
        const feeTiers: number[] = [500, 2000, 10000];

        for (const fee of feeTiers) {
            const poolAddress = await this.factoryContract.getPool(tokenIn, tokenOut, fee);

            if (poolAddress !== ethers.ZeroAddress) {
                console.log(`Valid pool found for ${tokenIn}-${tokenOut} with fee: ${fee}`);
                return fee;
            }

        }

        throw new Error(`No valid pool found for tokens ${tokenIn} and ${tokenOut}`);
    }

    /**
     * Check if a liquidity pool exists and has liquidity
     * @param tokenIn - Input token address
     * @param tokenOut - Output token address
     * @param fee - Fee tier (e.g., 3000 for 0.3%)
     * @returns true if the pool exists and has liquidity, false otherwise
     */
    private async poolExistsWithLiquidity(tokenIn: string, tokenOut: string, fee: number): Promise<boolean> {
        const poolAddress = await this.factoryContract.getPool(tokenIn, tokenOut, fee);

        console.log(`Pool found at address: ${poolAddress}`);

        const poolContract = new ethers.Contract(poolAddress, [
            "function liquidity() view returns (uint128)"
        ], this.signer);

        const liquidity = await poolContract.liquidity();
        console.log(`Pool liquidity: ${liquidity.toString()}`);

        return liquidity > 0;
    }

    /**
     * Executes multiple swaps via a multicall transaction after verifying pool liquidity.
     * @param params - Array of swap parameters
     */
    public async performSwaps(params: SwapParam[]): Promise<void> {
        const callData: string[] = [];

        for (const param of params) {
            if (!this.validateDeadline(param.deadline)) {
                throw new Error("Deadline has expired");
            }

            if (!(await this.hasSufficientBalance(param.tokenIn, param.amountIn))) {
                throw new Error(`Insufficient balance for token: ${param.tokenIn}`);
            }

            if (await this.needsApproval(param.amountIn, param.tokenIn)) {
                await this.approveToken(param.amountIn, param.tokenIn);
            }

            const poolFee = await this.getPoolFee(param.tokenIn, param.tokenOut);
            param.fee = poolFee;

            if (!(await this.poolExistsWithLiquidity(param.tokenIn, param.tokenOut, param.fee))) {
                throw new Error(`No liquidity available in the pool for tokens ${param.tokenIn} and ${param.tokenOut}`);
            }

            const slippageAdjustedAmountOutMin = this.calculateSlippage(param.amountOutMinimum, param.slippageTolerance);
            param.amountOutMinimum = Number(slippageAdjustedAmountOutMin);

            const encData = this.swapRouterContract.interface.encodeFunctionData("exactInputSingle", [param]);
            console.log("Encoded Data is --", encData);

            callData.push(encData);
        }

        const swapCalldata = this.swapRouterContract.interface.encodeFunctionData("multicall", [callData]);
        console.log("SwapData is --", swapCalldata);

        const txArgs = {
            to: this.UNISWAP_ROUTER_ADDRESS,
            from: await this.signer.getAddress(),
            data: swapCalldata,
            gasLimit: ethers.parseUnits("500000", "wei"),
        };

        try {
            const tx = await this.signer.sendTransaction(txArgs);
            console.log("Transaction sent. Hash:", tx.hash);

            const receipt = await tx.wait();
            console.log("Transaction confirmed. Receipt:", receipt);
        } catch (error) {
            console.error("Swap failed:", error);
        }
    }
}