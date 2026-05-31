# Track G fixtures — HTTP client call sites in Python.
import os
import requests
import httpx


def list_users():
    """requests.get('/health') — must yield framework=requests, method=GET."""
    return requests.get("/health")


def create_user(payload):
    """requests.post('/api/users') — POST method."""
    return requests.post("/api/users", json=payload)


def fetch_orders():
    """httpx.get('/api/orders') — framework=httpx, method=GET."""
    return httpx.get("/api/orders")


class CartService:
    def __init__(self, client):
        self.client = client

    def add_item(self, item):
        """client.post('/api/cart/items', json=item) — generic http-client."""
        return self.client.post("/api/cart/items", json=item)


def charge_customer(amount):
    """os.environ['PAYMENT_URL'] + '/charge' — recover envKey=PAYMENT_URL + /charge."""
    return requests.post(os.environ["PAYMENT_URL"] + "/charge", json={"amount": amount})


def dynamic_url(url):
    """No literal path — must NOT be recorded."""
    return requests.get(url)
