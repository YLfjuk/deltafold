// Tests capture Effect's default logger, which writes through console.log.

declare var console: {
	log(...data: Array<unknown>): void;
};
