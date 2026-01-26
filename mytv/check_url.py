import requests
import ffmpeg
import concurrent.futures
import time

def check_http_url(url, timeout=5, retries=2):
    """检查HTTP/HTTPS URL，支持重试"""
    for attempt in range(retries + 1):
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            start_time = time.time()
            response = requests.get(
                url, 
                timeout=timeout, 
                headers=headers, 
                stream=True
            )
            
            if response.status_code == 200:
                response.raw.read(1024)
                duration = time.time() - start_time
                return (url, True, f"有效 (响应时间: {duration:.2f}s)")
            else:
                return (url, False, f"状态码: {response.status_code}")
                
        except requests.exceptions.ConnectionError:
            if attempt == retries:
                return (url, False, "连接错误 (多次尝试失败)")
        except requests.exceptions.Timeout:
            if attempt == retries:
                return (url, False, "连接超时 (多次尝试失败)")
        except requests.exceptions.RequestException as e:
            if attempt == retries:
                return (url, False, f"其他错误: {str(e)}")
        if attempt < retries:
            time.sleep(1)  # 等待1秒后重试

def check_rtsp_rtp_url(url, timeout=5, retries=2):
    """检查RTSP/RTP URL，支持重试"""
    for attempt in range(retries + 1):
        try:
            start_time = time.time()
            # 配置FFmpeg输入
            input_args = {'rtsp_flags': 'prefer_tcp', 'timeout': str(timeout * 1000000)}  # 微秒
            
            stream = ffmpeg.input(url, **input_args)
            probe = ffmpeg.probe(url, **input_args)
            
            streams = probe.get('streams', [])
            if streams:
                duration = time.time() - start_time
                return (url, True, f"有效 (响应时间: {duration:.2f}s)")
            else:
                return (url, False, "无有效流")
                
        except ffmpeg.Error as e:
            if attempt == retries:
                return (url, False, f"FFmpeg错误: {str(e)} (多次尝试失败)")
        except Exception as e:
            if attempt == retries:
                return (url, False, f"连接错误: {str(e)} (多次尝试失败)")
        if attempt < retries:
            time.sleep(1)  # 等待1秒后重试

def check_url(url, timeout=5, retries=2):
    """根据URL协议选择检查方法"""
    url = url.lower()
    if url.startswith(('http://', 'https://')):
        return check_http_url(url, timeout, retries)
    elif url.startswith(('rtsp://', 'rtp://')):
        return check_rtsp_rtp_url(url, timeout, retries)
    else:
        return (url, False, "不支持的协议")

def check_iptv_sources(url_list, max_workers=10, timeout=5, retries=2):
    """检查多个IPTV源的有效性"""
    print(f"开始检测 {len(url_list)} 个直播源...")
    print(f"超时时间: {timeout}s, 最大重试次数: {retries}")
    print("-" * 50)
    
    valid_count = 0
    invalid_count = 0
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_url = {
            executor.submit(check_url, url, timeout, retries): url 
            for url in url_list
        }
        
        for future in concurrent.futures.as_completed(future_to_url):
            url = future_to_url[future]
            try:
                url, is_valid, status = future.result()
                print(f"{url}: {status}")
                if is_valid:
                    valid_count += 1
                else:
                    invalid_count += 1
            except Exception as e:
                print(f"{url}: 检查时发生错误: {str(e)}")
                invalid_count += 1
    
    print("-" * 50)
    print(f"检测完成！")
    print(f"有效源: {valid_count}")
    print(f"无效源: {invalid_count}")
    print(f"有效率: {valid_count/(valid_count + invalid_count)*100:.2f}%")

if __name__ == "__main__":
    # 示例URL列表
    iptv_urls = [
        "http://example.com:8080/stream1.ts",
        "rtsp://example.com:554/stream",
        "rtp://example.com:5004",
        "https://example.com/hls/stream.m3u8",
    ]
    
    # 从m3u文件读取（可选）
    """
    with open('playlist.m3u', 'r') as f:
        iptv_urls = [line.strip() for line in f if line.strip() and not line.startswith('#')]
    """
    
    # 开始检测
    check_iptv_sources(
        iptv_urls,
        max_workers=10,
        timeout=5,
        retries=2
    )