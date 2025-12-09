CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    google_id TEXT
);

ALTER TABLE cart
    DROP CONSTRAINT IF EXISTS cart_product_id_fkey,
    ADD CONSTRAINT cart_product_id_fkey
        FOREIGN KEY (product_id)
        REFERENCES products(id)
        ON DELETE CASCADE;
INSERT INTO products (name, price, description, image)
VALUES 
('Sample Product 1', 19.99, 'First test item', 'https://placehold.co/300'),
('Sample Product 2', 24.50, 'Second item', 'https://placehold.co/300');
