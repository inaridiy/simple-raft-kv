export const createNoopSignal = () => {
  return new AbortController().signal;
};
