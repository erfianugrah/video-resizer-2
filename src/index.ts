import { Hono } from 'hono';

const app = new Hono();

app.get('*', (c) => c.text('video-resizer-2'));

export default app;
