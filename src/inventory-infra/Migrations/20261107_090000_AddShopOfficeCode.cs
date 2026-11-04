using FluentMigrator;

namespace CineBoutique.Inventory.Infrastructure.Migrations;

/// <summary>
/// Code « office » de la boutique dans MCS (colonne <c>office</c> du fichier d'import de stock).
/// Les codes sont ceux des imports de décembre 2025 (W:\FINANCES\Contrôle de gestion\Inventaire physique\12.2025).
/// En province, la boutique et la lumière partagent le même dépôt ; à Saint-Denis, ils sont distincts (SDB / SDL).
/// </summary>
[Migration(20261107090000)]
public sealed class AddShopOfficeCode : Migration
{
    private const string ShopTable = "Shop";
    private const string OfficeCodeColumn = "OfficeCode";

    public override void Up()
    {
        if (!Schema.Table(ShopTable).Column(OfficeCodeColumn).Exists())
        {
            Alter.Table(ShopTable)
                .AddColumn(OfficeCodeColumn).AsString(16).Nullable();
        }

        Execute.Sql("""
UPDATE "Shop" AS s
SET "OfficeCode" = v.code
FROM (VALUES
    ('CinéBoutique Saint-Denis', 'SDB'),
    ('CinéBoutique Marseille', 'MAR'),
    ('CinéBoutique Montpellier', 'MTP'),
    ('CinéBoutique Bordeaux', 'BEG'),
    ('Lumière Saint-Denis', 'SDL'),
    ('Lumière Marseille', 'MAR'),
    ('Lumière Montpellier', 'MTP'),
    ('Lumière Bordeaux', 'BEG')
) AS v(name, code)
WHERE LOWER(s."Name") = LOWER(v.name)
  AND s."OfficeCode" IS NULL;
""");
    }

    public override void Down()
    {
        if (Schema.Table(ShopTable).Column(OfficeCodeColumn).Exists())
        {
            Delete.Column(OfficeCodeColumn).FromTable(ShopTable);
        }
    }
}
