export enum Side { BUY = 'BUY', SELL = 'SELL' }
export enum OrderType { GTC = 'GTC', FOK = 'FOK', GTD = 'GTD' }

export const ClobClient = jest.fn().mockImplementation(() => ({
  createOrder: jest.fn(),
  postOrder: jest.fn(),
  getOrderBook: jest.fn(),
  cancelOrder: jest.fn(),
  createOrDeriveApiKey: jest.fn(),
}));
