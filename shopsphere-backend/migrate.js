const fs = require("fs");
const path = require("path");

const pool = require("./db");

async function migrate() {

    console.log("Running database migrations...");

    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations(
            id INT AUTO_INCREMENT PRIMARY KEY,
            filename VARCHAR(255) UNIQUE,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const migrationsDir = path.join(__dirname, "migrations");

    const files = fs
        .readdirSync(migrationsDir)
        .filter(file => file.endsWith(".sql"))
        .sort();

    for (const file of files) {

        const [rows] = await pool.query(
            "SELECT * FROM schema_migrations WHERE filename=?",
            [file]
        );

        if (rows.length > 0) {

            console.log(`Skipping ${file}`);

            continue;
        }

        console.log(`Executing ${file}`);

        const sql = fs.readFileSync(
            path.join(migrationsDir, file),
            "utf8"
        );

        const connection = await pool.getConnection();

        try {

            await connection.beginTransaction();

            const statements = sql
                .split(";")
                .map(s => s.trim())
                .filter(Boolean);

            for (const statement of statements) {

                await connection.query(statement);

            }

            await connection.query(
                "INSERT INTO schema_migrations(filename) VALUES(?)",
                [file]
            );

            await connection.commit();

            console.log(`${file} completed`);

        } catch (err) {

            await connection.rollback();

            throw err;

        } finally {

            connection.release();

        }

    }

    console.log("Database migrations complete");

}

module.exports = migrate;