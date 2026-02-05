import { useSyncExternalStore } from 'react';

type WindowStateProviderProps = {
  children: React.ReactNode;
};

type WindowStateProviderState = {
  isMaximized: boolean;
};

const initialState: WindowStateProviderState = {
  isMaximized: false,
};

let currentState: WindowStateProviderState = initialState;
let isInitialized = false;
const listeners = new Set<() => void>();

const notifyListeners = () => {
  listeners.forEach((listener) => listener());
};

const updateState = (isMaximized: boolean) => {
  if (currentState.isMaximized === isMaximized) return;
  currentState = { isMaximized };
  notifyListeners();
};

const ensureInitialized = () => {
  if (isInitialized || typeof window === 'undefined') return;
  isInitialized = true;

  window.appControl
    ?.getMaximizeState?.()
    .then((state: boolean) => updateState(state))
    .catch(() => null);

  window.appControl?.onMaximizeChanged?.((state: boolean) => {
    updateState(state);
  });
};

const subscribe = (listener: () => void) => {
  ensureInitialized();
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => currentState;
const getServerSnapshot = () => initialState;

export function WindowStateProvider({ children }: WindowStateProviderProps) {
  return <>{children}</>;
}

export const useWindowState = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
