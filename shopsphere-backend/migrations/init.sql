CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description VARCHAR(500),
    category VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_category (category),
    INDEX idx_is_active (is_active)
);

INSERT INTO products (sku, name, description, category, price, stock_quantity)
VALUES
    ('ELEC-LAP-001', 'Laptop', '14-inch ultrabook, 16GB RAM, 512GB SSD', 'Electronics', 79999.00, 24),
    ('ELEC-HDP-002', 'Headphones', 'Wireless over-ear, active noise cancellation', 'Electronics', 4999.00, 120),
    ('ELEC-KBD-003', 'Keyboard', 'Mechanical, hot-swappable switches', 'Electronics', 2999.00, 65),
    ('ELEC-MOU-004', 'Wireless Mouse', 'Ergonomic, 2.4GHz + Bluetooth', 'Electronics', 1499.00, 8),
    ('HOME-LMP-005', 'Desk Lamp', 'LED, adjustable color temperature', 'Home', 1299.00, 0),
    ('HOME-CHR-006', 'Office Chair', 'Mesh back, adjustable lumbar support', 'Home', 8999.00, 15)
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    description = VALUES(description),
    category = VALUES(category);