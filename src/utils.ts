import { Server } from "@stellar/stellar-sdk/minimal/rpc";
import { env } from "cloudflare:workers";

export const rpc = new Server(env.RPC_URL)

export function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper function to parse Range header (basic implementation)
export function parseRange(header: string, size: number): { offset: number; length?: number } | undefined {
	const bytesPrefix = 'bytes=';
	if (!header.startsWith(bytesPrefix)) return undefined;

	const ranges = header.substring(bytesPrefix.length).split(',')[0]; // We only support single range for simplicity
	if (!ranges) return undefined;

	const [startStr, endStr] = ranges.split('-');
	const start = parseInt(startStr, 10);

	if (isNaN(start) || start < 0) return undefined; // Added start < 0 check

	if (endStr) {
		const end = parseInt(endStr, 10);
		// Allow end to be equal to size - 1 (inclusive end)
		if (isNaN(end) || end < start || end >= size) return undefined; 
		return { offset: start, length: end - start + 1 };
	} else {
		// If no end is specified, it means from start to the end of the file
		if (start >= size && size > 0) return undefined; // If size is 0, start=0 is valid for an empty range
		if (start >= size && size > 0) return undefined; 
		return { offset: start, length: undefined }; // Explicitly set length to undefined
	}
}