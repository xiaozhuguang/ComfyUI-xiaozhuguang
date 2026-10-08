import asyncio
import io
from aiohttp import web
from server import PromptServer
from .session_store import get


@PromptServer.instance.routes.get('/xiaozhuguang/pose/session/{token}')
async def session(request):
    data = get(request.match_info['token'])
    if data is None:
        raise web.HTTPNotFound(text='预览缓存已失效，请重新执行节点')
    return web.json_response({k: data[k] for k in ('frames', 'fps', 'source_digest')} |
                             {'has_images': data['images'] is not None})


@PromptServer.instance.routes.get('/xiaozhuguang/pose/session/{token}/image/{index}')
async def image(request):
    import numpy as np
    from PIL import Image
    data = get(request.match_info['token'])
    if data is None or data['images'] is None:
        raise web.HTTPNotFound()
    try:
        index = int(request.match_info['index'])
    except ValueError:
        raise web.HTTPBadRequest()
    if not 0 <= index < len(data['frames']):
        raise web.HTTPNotFound()
    images = data['images']
    def encode():
        pixels = images[0 if len(images) == 1 else index].detach().cpu().numpy()
        buffer = io.BytesIO()
        Image.fromarray(np.clip(pixels * 255, 0, 255).astype('uint8')).save(buffer, format='PNG')
        return buffer.getvalue()

    payload = await asyncio.to_thread(encode)
    return web.Response(body=payload, content_type='image/png',
                        headers={'Cache-Control': 'private, max-age=3600'})
