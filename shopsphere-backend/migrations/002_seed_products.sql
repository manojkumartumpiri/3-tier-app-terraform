INSERT INTO products(name,price)
SELECT 'Laptop',80000
WHERE NOT EXISTS(
    SELECT 1 FROM products WHERE name='Laptop'
);

INSERT INTO products(name,price)
SELECT 'Keyboard',8000
WHERE NOT EXISTS(
    SELECT 1 FROM products WHERE name='Keyboard'
);

INSERT INTO products(name,price)
SELECT 'Mouse',800
WHERE NOT EXISTS(
    SELECT 1 FROM products WHERE name='Mouse'
);