#!/usr/bin/env python3
# ============================================================
# 스테이션별 QR 이미지 일괄 생성
#
# 30_안내판_NFC사인_사양.md §3 규격을 그대로 지킨다:
#   · 50×50mm · 300dpi = 591px
#   · quiet zone 최소 4모듈
#   · 흰 바탕 · 검정 코드 (색 반전·컬러 금지)
#   · 오류정정 레벨 H — 어두운 B1 + 관객 훼손 전제
#
# 사용:
#   pip3 install qrcode pillow --break-system-packages
#   python3 make_qr.py https://minniepark.github.io/fringe2026/
#
# 출력: ./qr/ 에 스테이션별 PNG + 인쇄 확인용 대조 시트
# ============================================================

import os
import sys

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_H
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit('먼저 설치하세요:\n'
             '  pip3 install qrcode pillow --break-system-packages')

# 30 §2 — 스테이션 목록 (config.js와 같아야 한다)
STATIONS = [
    ('00', '입장'),
    ('01', '메인1 — 명명'),
    ('02', '부1 — 재연'),
    ('03', '부2 — 애도'),
    ('04', '기록'),
    ('05', '출구 — 설문'),
]

DPI = 300
SIZE_MM = 50
PX = round(SIZE_MM / 25.4 * DPI)      # 591px
QUIET_MODULES = 4                     # 30 §3 — 이거 없으면 인식률 급락


def build(url_base, out_dir='qr'):
    os.makedirs(out_dir, exist_ok=True)
    made = []

    for sid, name in STATIONS:
        sep = '&' if '?' in url_base else '?'
        url = f'{url_base}{sep}station={sid}'

        qr = qrcode.QRCode(
            version=None,
            error_correction=ERROR_CORRECT_H,   # 훼손·저조도 대비
            box_size=10,
            border=QUIET_MODULES,
        )
        qr.add_data(url)
        qr.make(fit=True)

        img = qr.make_image(fill_color='black', back_color='white')
        img = img.convert('L').resize((PX, PX), Image.NEAREST)  # 뭉개짐 금지

        path = os.path.join(out_dir, f'qr_{sid}.png')
        img.save(path, dpi=(DPI, DPI))
        made.append((sid, name, url, path, qr.version))
        print(f'  {sid}  v{qr.version:<2}  {url}')

    # 대조 시트 — 인쇄 전에 눈으로 확인하고, 현장에서 폰으로 실제 테스트
    sheet_w, cell = 2480, 780          # A4 300dpi 폭
    rows = (len(made) + 2) // 3
    sheet = Image.new('L', (sheet_w, rows * cell + 120), 255)
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype(
            '/System/Library/Fonts/AppleSDGothicNeo.ttc', 34)
    except Exception:
        font = ImageFont.load_default()

    d.text((40, 40), f'서울 프린지 2026 — QR 대조 시트  /  {url_base}',
           fill=0, font=font)

    for i, (sid, name, url, path, _) in enumerate(made):
        x = 60 + (i % 3) * (cell + 20)
        y = 120 + (i // 3) * cell
        q = Image.open(path).resize((600, 600), Image.NEAREST)
        sheet.paste(q, (x, y))
        d.text((x, y + 615), f'{sid}  {name}', fill=0, font=font)

    sheet_path = os.path.join(out_dir, '_대조시트.png')
    sheet.save(sheet_path, dpi=(DPI, DPI))

    # NFC 쓰기용 URL 목록 (30 §1 — NFC Tools 앱에 그대로 입력)
    with open(os.path.join(out_dir, '_NFC_URL목록.txt'), 'w',
              encoding='utf-8') as f:
        f.write('NFC Tools → Write → Add a record → URL\n')
        f.write('URL 확정 후 읽기전용 잠금(lock). ⚠️ 잠그면 되돌릴 수 없음.\n')
        f.write('잠그기 전 다른 폰 2대로 읽기 테스트 필수.\n\n')
        for sid, name, url, _, _ in made:
            f.write(f'{sid}  {name}\n    {url}\n\n')

    print(f'\n완료 → {out_dir}/')
    print(f'  · 스테이션별 PNG {len(made)}장 (50×50mm @300dpi)')
    print(f'  · _대조시트.png — 인쇄 전 확인용')
    print(f'  · _NFC_URL목록.txt — NFC Tools에 입력할 주소')
    print('\n🔴 인쇄 전 반드시:')
    print('  1. 무광 용지 · 레이저 (유광은 조명 반사로 죽고 잉크젯은 습기에 번짐)')
    print('  2. 실제 인쇄물을 어두운 방에서 폰으로 스캔 테스트')
    print('  3. quiet zone(흰 여백)을 잘라내지 말 것')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('사용법: python3 make_qr.py <폰허브 URL>\n'
                 '예:    python3 make_qr.py https://minniepark.github.io/fringe2026/')
    build(sys.argv[1].rstrip() )
