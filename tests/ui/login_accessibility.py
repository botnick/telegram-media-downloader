"""Login/reset keyboard and accessible-name checks with local HTTP fixtures.
Run: python3 tests/ui/login_accessibility.py (requires Playwright Chromium).
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

html = (Path(__file__).resolve().parents[2] /
        'core-service/internal/webassets/public/login.html').read_text()
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.route('**/*', lambda route: route.abort())
    page.route('http://localhost/css/tailwind.css', lambda route: route.fulfill(
        content_type='text/css', body=(Path(__file__).resolve().parents[2] /
        'core-service/internal/webassets/public/css/tailwind.css').read_text()))
    page.route('http://localhost/login', lambda route: route.fulfill(
        content_type='text/html', body=html))
    page.route('http://localhost/api/login', lambda route: route.fulfill(
        status=401, json={'success': False, 'error': 'Invalid password'}))
    page.route('http://localhost/api/auth/reset/request', lambda route: route.fulfill(
        json={'success': True}))
    page.route('http://localhost/api/auth/reset/confirm', lambda route: route.fulfill(
        status=400, json={'success': False, 'error': 'Token expired'}))
    for width in (390, 1280):
        page.set_viewport_size({'width': width, 'height': 900})
        page.goto('http://localhost/login')
        expect(page.get_by_label('Reset token')).not_to_be_visible()
        page.get_by_label('Password', exact=True).fill('incorrect')
        page.get_by_label('Password', exact=True).press('Enter')
        expect(page.get_by_role('alert')).to_have_text('Invalid password')
        page.get_by_role('button', name='Forgot password?').focus()
        page.keyboard.press('Enter')
        page.keyboard.press('Tab')
        expect(page.get_by_role('button', name='Send token')).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.get_by_role('status')).to_contain_text('Token printed')
        page.keyboard.press('Tab')
        expect(page.get_by_label('Reset token')).to_be_focused()
        page.keyboard.type('expired-token')
        page.keyboard.press('Tab')
        expect(page.get_by_label('New password (min 8 chars)')).to_be_focused()
        page.keyboard.type('new-password')
        page.keyboard.press('Tab')
        expect(page.get_by_role('button', name='Reset and sign in')).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.get_by_role('status')).to_have_text('Token expired')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        print(f'PASS keyboard reset, accessible labels and status/error roles at {width}px')
    browser.close()
