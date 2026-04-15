# Docker Shop Backend MVP

Microservice MVP for exam requirements:
- `auth-service`
- `user-service`
- `product-service`
- `order-service`
- `notification-service`
- `rabbitmq` and `redis` in Docker

## Architecture

### Synchronous interaction
- REST APIs between frontend/client and services.

### Asynchronous interaction
- RabbitMQ exchange: `shop.events`
- Events:
  - `user.registered`
  - `order.created`
  - `order.paid`

### Redis usage (mandatory logic)
- Implemented in `product-service`.
- Cache is used for:
  - `GET /products`
  - `GET /products/:id`
- TTL is configurable (`CACHE_TTL`, default `120` seconds).
- Cache invalidation happens on:
  - product creation
  - product update
  - product deletion

`GET /products*` returns `source: "cache"` or `source: "db"` to clearly demonstrate that cache is actually used.

### i18n
- Supported languages: English (`en`) and Ukrainian (`uk`).
- Backend reads `Accept-Language` header.
- Localized errors and health messages are returned.

## Run

From repository root:

```bash
docker-compose up --build
```

Services:
- Auth: `http://localhost:4001`
- User: `http://localhost:4002`
- Product: `http://localhost:4003`
- Order: `http://localhost:4004`
- RabbitMQ UI: `http://localhost:15672` (guest/guest)

## API quick demo

### 1) Register admin and customer

```bash
curl -X POST http://localhost:4001/register -H "Content-Type: application/json" -H "Accept-Language: en" -d "{\"name\":\"Admin\",\"email\":\"admin@test.com\",\"password\":\"123456\",\"role\":\"Admin\"}"
curl -X POST http://localhost:4001/register -H "Content-Type: application/json" -H "Accept-Language: uk" -d "{\"name\":\"Customer\",\"email\":\"user@test.com\",\"password\":\"123456\",\"role\":\"Customer\"}"
```

### 2) Login and get tokens

```bash
curl -X POST http://localhost:4001/login -H "Content-Type: application/json" -d "{\"email\":\"admin@test.com\",\"password\":\"123456\"}"
curl -X POST http://localhost:4001/login -H "Content-Type: application/json" -d "{\"email\":\"user@test.com\",\"password\":\"123456\"}"
```

### 3) Product CRUD (admin)

```bash
curl -X POST http://localhost:4003/products -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"Laptop\",\"description\":\"Gaming laptop\",\"price\":1200,\"category\":\"Electronics\"}"
```

### 4) Redis cache demonstration

Call twice:

```bash
curl http://localhost:4003/products
curl http://localhost:4003/products
```

Expected:
- first response: `"source": "db"`
- second response: `"source": "cache"`

After product update/delete/create, cache is invalidated automatically.

### 5) Create order (customer)

```bash
curl -X POST http://localhost:4004/orders -H "Authorization: Bearer <CUSTOMER_TOKEN>" -H "Content-Type: application/json" -d "{\"items\":[{\"productId\":1,\"quantity\":2}]}"
```

### 6) RabbitMQ event + notification handling

`notification-service` consumes and logs:
- `user.registered`
- `order.created`
- `order.paid`

Check logs:

```bash
docker-compose logs -f notification-service
```

### 7) Change order status to paid (admin)

```bash
curl -X PATCH http://localhost:4004/orders/1/status -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d "{\"status\":\"Paid\"}"
```

## Roles and access

- Admin:
  - Manage products (`POST/PUT/DELETE /products`)
  - View all orders (`GET /orders`)
  - Change order status (`PATCH /orders/:id/status`)
- Customer:
  - View products
  - Create orders
  - View own orders only

## Notes

- Data is in-memory for MVP demonstration.
- Frontend can call services directly and must pass:
  - JWT in `Authorization: Bearer ...`
  - `Accept-Language: en|uk`# docker_shop_backend
