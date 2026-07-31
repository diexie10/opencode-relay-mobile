// lib/api-config.js — All API endpoint paths and SSE event names as single source of truth
// Phase 0 verified values from opencode serve API

const ENDPOINTS = {
  HEALTH: '/global/health',
  CREATE_SESSION: '/session',
  LIST_SESSIONS: '/session',
  GET_SESSION: '/session/{sessionID}',
  SEND_MESSAGE: '/session/{sessionID}/message',
  GET_MESSAGES: '/session/{sessionID}/message',
  GET_QUESTION: '/question',
  REPLY_QUESTION: '/question/{requestID}/reply',
  REJECT_QUESTION: '/question/{requestID}/reject',
  GET_EVENT: '/global/event',
  SESSION_STATUS: '/session/status'
};

const SSE_EVENTS = {
  MESSAGE: 'message',
  TOOL_CALL: 'tool_call',
  DONE: 'done',
  ERROR: 'error',
  STATUS: 'status'
};

module.exports = { ENDPOINTS, SSE_EVENTS };
