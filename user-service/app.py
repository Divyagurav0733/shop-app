import os
import time
import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
PORT = int(os.getenv("PORT", 5000))


def get_conn():
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", 5432)),
        dbname=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASS"),
    )


def init_db():
    for _ in range(30):
        try:
            conn = get_conn()
            with conn, conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(100) NOT NULL,
                        email VARCHAR(150) UNIQUE NOT NULL,
                        password_hash VARCHAR(255) NOT NULL,
                        created_at TIMESTAMP DEFAULT NOW()
                    )""")
            conn.close()
            print("user-service: database ready", flush=True)
            return
        except psycopg2.OperationalError as e:
            print("user-service: waiting for database...", e, flush=True)
            time.sleep(2)
    raise SystemExit(1)


def public(row):
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


@app.get("/health")
def health():
    return {"service": "user", "status": "ok"}


@app.post("/users")
def register():
    d = request.get_json(silent=True) or {}
    name = (d.get("name") or "").strip()
    email = (d.get("email") or "").strip().lower()
    pw = d.get("password") or ""
    if not name or not email or len(pw) < 6:
        return jsonify(error="name, email and a password of 6+ characters are required"), 400

    conn = get_conn()
    try:
        with conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO users (name, email, password_hash) VALUES (%s, %s, %s) RETURNING id, name, email",
                (name, email, generate_password_hash(pw)),
            )
            row = cur.fetchone()
        return jsonify(row), 201
    except psycopg2.IntegrityError:
        return jsonify(error="email already registered"), 409
    finally:
        conn.close()


@app.post("/users/login")
def login():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip().lower()
    pw = d.get("password") or ""

    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            row = cur.fetchone()
    finally:
        conn.close()

    if not row or not check_password_hash(row["password_hash"], pw):
        return jsonify(error="invalid email or password"), 401
    return jsonify(public(row))


@app.get("/users/<int:user_id>")
def get_user(user_id):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return jsonify(error="user not found"), 404
    return jsonify(public(row))


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=PORT)
