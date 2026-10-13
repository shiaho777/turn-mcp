from __future__ import annotations
import json
import os
import urllib.error
import urllib.request
import uuid
from typing import List, Optional

class TurnMcpError(Exception):
    pass

class TurnMcpTimeout(TurnMcpError):
    pass

class TurnMcpCanceled(TurnMcpError):
    pass

class TurnMcpInterrupted(TurnMcpError):
    pass

class TurnMcpClient:

    def __init__(self, base_url: Optional[str]=None, api_key: Optional[str]=None, default_timeout_seconds: int=600) -> None:
        self.base_url = (base_url or os.environ.get('TURN_MCP_URL', 'http://127.0.0.1:3737')).rstrip('/')
        self.api_key = api_key or os.environ.get('TURN_MCP_API_KEY', '')
        self.default_timeout_seconds = default_timeout_seconds

    def wait(self, context: str, question: Optional[str]=None, options: Optional[List[str]]=None, agent_name: Optional[str]=None, session_id: Optional[str]=None, timeout_seconds: Optional[int]=None) -> str:
        payload: dict = {'context': context, 'sessionId': session_id or f'py-{uuid.uuid4().hex[:12]}'}
        effective_timeout = timeout_seconds if timeout_seconds is not None else self.default_timeout_seconds
        payload['timeoutSeconds'] = effective_timeout
        if question:
            payload['question'] = question
        if options:
            payload['options'] = options
        if agent_name:
            payload['agentName'] = agent_name
        encoded = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(f'{self.base_url}/api/waits/create-and-wait', data=encoded, headers={'Content-Type': 'application/json'}, method='POST')
        if self.api_key:
            req.add_header('x-turn-mcp-api-key', self.api_key)
        http_timeout = effective_timeout + 60 if effective_timeout > 0 else None
        try:
            with urllib.request.urlopen(req, timeout=http_timeout) as resp:
                body = json.loads(resp.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            raw = exc.read() if exc.fp else b'{}'
            try:
                body = json.loads(raw.decode('utf-8'))
            except Exception:
                body = {}
            raise TurnMcpError(body.get('error', f'HTTP {exc.code}')) from exc
        except OSError as exc:
            raise TurnMcpError(f'Connection error: {exc}') from exc
        resolution = body.get('resolution')
        if resolution == 'timeout':
            raise TurnMcpTimeout('Wait timed out — the human did not respond in time.')
        if resolution == 'canceled':
            raise TurnMcpCanceled('Wait was canceled by the operator.')
        if resolution == 'interrupted':
            raise TurnMcpInterrupted('Wait was interrupted because the server shut down or the session ended.')
        if resolution == 'message':
            message = body.get('message')
            if not isinstance(message, str):
                raise TurnMcpError('Server returned an unexpected response format.')
            return message
        raise TurnMcpError(f'Unexpected resolution from server: {resolution!r}')

    async def async_wait(self, context: str, question: Optional[str]=None, options: Optional[List[str]]=None, agent_name: Optional[str]=None, session_id: Optional[str]=None, timeout_seconds: Optional[int]=None) -> str:
        import asyncio
        import functools
        fn = functools.partial(self.wait, context, question=question, options=options, agent_name=agent_name, session_id=session_id, timeout_seconds=timeout_seconds)
        try:
            return await asyncio.to_thread(fn)
        except AttributeError:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(None, fn)
