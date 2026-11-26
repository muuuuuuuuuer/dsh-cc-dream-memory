import { sessionIdOf } from './api.js';

let backendFactory = null;

export function setBackendFactory(factory) {
  backendFactory = factory;
}

export function resolveBackend(props) {
  if (props && props.memBackend && typeof props.memBackend === 'object') return props.memBackend;
  if (typeof backendFactory === 'function') {
    const sessionId = sessionIdOf(props && props.memSessionId) || sessionIdOf(props && props.sessionId);
    return backendFactory(sessionId);
  }
  return null;
}

export function resolveT(props) {
  if (props && typeof props.t === 'function') return props.t;
  if (props && typeof props.memT === 'function') return props.memT;
  return (key) => key;
}
