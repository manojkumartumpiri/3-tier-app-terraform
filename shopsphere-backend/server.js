const express = require("express");

const pool = require("./db");
const migrate = require("./migrate");

const app = express();

app.use(express.json());

app.get("/health", (req,res)=>{
    res.send("Healthy");
});

app.get("/api/products", async(req,res)=>{

    try{

        const [rows] = await pool.query(
            "SELECT * FROM products"
        );

        res.json(rows);

    }catch(err){

        console.error(err);

        res.status(500).json({
            error:"Database Error"
        });

    }

});

const PORT = process.env.PORT || 5000;

(async()=>{

    try{

        await migrate();

        app.listen(PORT,()=>{

            console.log(`Server running on ${PORT}`);

        });

    }catch(err){

        console.error(err);

        process.exit(1);

    }

})();