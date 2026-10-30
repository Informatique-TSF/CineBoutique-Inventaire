using FluentMigrator;

namespace CineBoutique.Inventory.Infrastructure.Migrations;

/// <summary>
/// Index manquants sur les clés étrangères les plus sollicitées par le calcul des conflits
/// et les rapports (CountLine.CountingRunId, CountLine.ProductId, Conflict.CountLineId).
/// PostgreSQL n'indexe pas automatiquement les colonnes de clé étrangère.
/// </summary>
[Migration(20261106090000)]
public sealed class AddCountLineConflictIndexes : Migration
{
    private const string CountLineTable = "CountLine";
    private const string ConflictTable = "Conflict";

    public override void Up()
    {
        Execute.Sql(@"CREATE INDEX IF NOT EXISTS ix_countline_countingrunid ON ""CountLine"" (""CountingRunId"");");
        Execute.Sql(@"CREATE INDEX IF NOT EXISTS ix_countline_productid ON ""CountLine"" (""ProductId"");");
        Execute.Sql(@"CREATE INDEX IF NOT EXISTS ix_conflict_countlineid ON ""Conflict"" (""CountLineId"");");
    }

    public override void Down()
    {
        if (Schema.Table(ConflictTable).Index("ix_conflict_countlineid").Exists())
        {
            Delete.Index("ix_conflict_countlineid").OnTable(ConflictTable);
        }

        if (Schema.Table(CountLineTable).Index("ix_countline_productid").Exists())
        {
            Delete.Index("ix_countline_productid").OnTable(CountLineTable);
        }

        if (Schema.Table(CountLineTable).Index("ix_countline_countingrunid").Exists())
        {
            Delete.Index("ix_countline_countingrunid").OnTable(CountLineTable);
        }
    }
}
