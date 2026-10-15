# ShopHub deployment (4 GCP VMs, Ubuntu 24.04)

| VM | Tag | Runs | Port |
|---|---|---|---|
| frontend-gateway-vm | gateway-vm | nginx frontend + api-gateway | 80, 8080 |
| product-vm | backend-vm | product-service (Node) + MySQL | 4000 |
| user-vm | backend-vm | user-service (Python/Flask) + PostgreSQL | 5000 |
| order-vm | backend-vm | order-service (Node) + MySQL | 6000 |

Write down the internal IPs: PRODUCT_IP, USER_IP, ORDER_IP. GATEWAY_EXT is the external IP of frontend-gateway-vm.

## 0. Push to Git (from your laptop)
    cd shop-app
    git init && git add . && git commit -m "ShopHub"
    git remote add origin https://github.com/<you>/shop-app.git
    git branch -M main && git push -u origin main

## 1. Install Docker on every VM
    sudo apt-get update
    sudo apt-get install -y docker.io git
    sudo systemctl enable --now docker
    sudo usermod -aG docker $USER
    exit      # then SSH back in

Then clone on each VM:
    git clone https://github.com/<you>/shop-app.git
    cd shop-app

## 2. product-vm (start first)
    docker run -d --name mysql-products --restart unless-stopped \
      -e MYSQL_ROOT_PASSWORD=changeme123 -e MYSQL_DATABASE=productdb \
      -e MYSQL_USER=productadmin -e MYSQL_PASSWORD=changeme123 \
      -p 3306:3306 mysql:8.0
    sleep 20
    cd product-service
    docker build -t product-service .
    docker run -d --name product-service --restart unless-stopped --network host \
      -e PORT=4000 -e DB_HOST=127.0.0.1 -e DB_PORT=3306 \
      -e DB_NAME=productdb -e DB_USER=productadmin -e DB_PASS=changeme123 \
      product-service
    curl http://localhost:4000/health

## 3. user-vm
    docker run -d --name postgres-users --restart unless-stopped \
      -e POSTGRES_DB=userdb -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=changeme123 \
      -p 5432:5432 postgres:16
    sleep 15
    cd user-service
    docker build -t user-service .
    docker run -d --name user-service --restart unless-stopped --network host \
      -e PORT=5000 -e DB_HOST=127.0.0.1 -e DB_PORT=5432 \
      -e DB_NAME=userdb -e DB_USER=postgres -e DB_PASS=changeme123 \
      user-service
    curl http://localhost:5000/health

## 4. order-vm
    docker run -d --name mysql-orders --restart unless-stopped \
      -e MYSQL_ROOT_PASSWORD=changeme123 -e MYSQL_DATABASE=orderdb \
      -e MYSQL_USER=orderadmin -e MYSQL_PASSWORD=changeme123 \
      -p 3306:3306 mysql:8.0
    sleep 20
    cd order-service
    docker build -t order-service .
    docker run -d --name order-service --restart unless-stopped --network host \
      -e PORT=6000 -e DB_HOST=127.0.0.1 -e DB_PORT=3306 \
      -e DB_NAME=orderdb -e DB_USER=orderadmin -e DB_PASS=changeme123 \
      -e USER_SERVICE_URL=http://<USER_IP>:5000 \
      -e PRODUCT_SERVICE_URL=http://<PRODUCT_IP>:4000 \
      order-service
    curl http://localhost:6000/health

## 5. frontend-gateway-vm
    docker network create shop-net
    cd shop-app/api-gateway
    docker build -t api-gateway .
    docker run -d --name api-gateway --network shop-net --restart unless-stopped -p 8080:8080 \
      -e PORT=8080 \
      -e PRODUCT_SERVICE_URL=http://<PRODUCT_IP>:4000 \
      -e USER_SERVICE_URL=http://<USER_IP>:5000 \
      -e ORDER_SERVICE_URL=http://<ORDER_IP>:6000 \
      api-gateway
    curl http://localhost:8080/health
    curl http://localhost:8080/api/products

    cd ../frontend
    docker build -t frontend .
    docker run -d --name frontend --network shop-net --restart unless-stopped -p 80:80 frontend

Open http://<GATEWAY_EXT> in a browser.

## 6. Test end to end
1. Register and log in (user-vm + PostgreSQL)
2. Add products to cart and place an order (order-vm calls user-vm and product-vm, then writes MySQL)
3. Check stock dropped on the product list (product-vm MySQL updated by the backend-to-backend call)

Useful checks for the report:
- Direct access blocked: curl http://<PRODUCT_IP>:4000/products from your laptop should time out
- DB contents:
    docker exec -it mysql-products mysql -u productadmin -pchangeme123 productdb -e "SELECT * FROM products;"
    docker exec -it postgres-users psql -U postgres -d userdb -c "SELECT id,name,email FROM users;"
    docker exec -it mysql-orders mysql -u orderadmin -pchangeme123 orderdb -e "SELECT * FROM orders; SELECT * FROM order_items;"

## Notes
- Passwords are passed as env vars for demo purposes. Use Secret Manager for anything real.
- Login returns the user record without a token, which is fine for a demo. Add JWT if you need real sessions.
