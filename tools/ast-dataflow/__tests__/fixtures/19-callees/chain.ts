interface Client {
  get(path: string): string;
}

export const api: { client: Client } = {
  client: {
    get(path: string): string {
      return path;
    },
  },
};

export function usesChain(): string {
  return api.client.get('/x');
}
